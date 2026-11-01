import { EventEmitter } from 'events';
import { cockpitToolsWs, AccountTokenInfo, AccountInfo } from './cockpitToolsWs';
import { credentialStorage } from '../auto_trigger/credential_storage';
import { oauthService } from '../auto_trigger/oauth_service';
import { logger } from '../shared/log_service';

const SYNC_COOLDOWN_MS = 10000;

let syncInProgress = false;
let lastSyncAt = 0;

export const cockpitToolsSyncEvents = new EventEmitter();

function toUnixSeconds(iso?: string): number | undefined {
    if (!iso) {
        return undefined;
    }
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) {
        return undefined;
    }
    return Math.floor(ms / 1000);
}

function toIsoFromUnixSeconds(seconds?: number): string {
    if (!seconds || seconds <= 0) {
        return new Date(0).toISOString();
    }
    return new Date(seconds * 1000).toISOString();
}

/**
 * 拉取远端账号列表（不含 token）。
 * 明文 token 属高敏感数据：仅当确认存在"远端有、本地无"的账号时才再拉一次带 token 的清单，
 * 避免每次同步都把全量 refresh/access token 读进扩展进程内存。
 */
async function fetchRemoteAccountList(): Promise<AccountInfo[]> {
    const response = await cockpitToolsWs.getAccounts();
    return response.accounts ?? [];
}

async function fetchRemoteAccountsWithTokens(): Promise<AccountTokenInfo[]> {
    const response = await cockpitToolsWs.getAccountsWithTokens();
    return response.accounts ?? [];
}

/**
 * 双向同步 Cockpit Tools 账号（仅在 WS 连接正常时执行）
 */
export async function syncAccountsWithCockpitTools(options?: { force?: boolean; reason?: string }): Promise<void> {
    if (!cockpitToolsWs.isConnected) {
        return;
    }

    const now = Date.now();
    if (syncInProgress) {
        return;
    }
    if (!options?.force && now - lastSyncAt < SYNC_COOLDOWN_MS) {
        return;
    }

    syncInProgress = true;
    lastSyncAt = now;

    try {
        logger.info(`[Sync] Start (reason=${options?.reason ?? 'unknown'})`);
        let remoteAccounts: AccountInfo[] = await fetchRemoteAccountList();
        let remoteEmails = remoteAccounts.map(acc => acc.email);
        let remoteSet = new Set(remoteEmails);

        const previousRemoteEmails = credentialStorage.getToolsAccountSnapshot();
        const previousRemoteSet = new Set(previousRemoteEmails);

        const localCredentials = await credentialStorage.getAllCredentials();
        const localEmails = Object.keys(localCredentials);
        const localSet = new Set(localEmails);

        logger.info(`[Sync] Local=${localEmails.length} Remote=${remoteAccounts.length} PrevRemote=${previousRemoteEmails.length}`);
        let pushedAny = false;
        let localChanged = false;

        // 处理本地存在但远端不存在的账号
        for (const email of localEmails) {
            if (remoteSet.has(email)) {
                continue;
            }

            // 如果之前远端存在，现在消失，视为远端删除
            if (previousRemoteSet.has(email)) {
                await credentialStorage.deleteCredentialForAccount(email, true);
                localSet.delete(email);
                localChanged = true;
                logger.info(`[Sync] Local delete (remote removed): ${email}`);
                continue;
            }

            const credential = localCredentials[email];
            if (!credential?.refreshToken || credential.isInvalid) {
                logger.debug(`[Sync] Skip push (missing/invalid token): ${email}`);
                continue;
            }

            const expiresAt = toUnixSeconds(credential.expiresAt);
            const result = await cockpitToolsWs.addAccount(
                email,
                credential.refreshToken,
                credential.accessToken,
                expiresAt,
            );
            if (result.success) {
                pushedAny = true;
                logger.info(`[Sync] Push to Tools: ${email}`);
            } else {
                logger.warn(`[Sync] 推送账号到 Tools 失败: ${email} - ${result.message}`);
            }
        }

        if (pushedAny) {
            remoteAccounts = await fetchRemoteAccountList();
            remoteEmails = remoteAccounts.map(acc => acc.email);
            remoteSet = new Set(remoteEmails);
        }

        // 导入远端存在但本地不存在的账号：仅此时才拉取一次明文 token 清单
        const missingEmails = remoteEmails.filter(email => !localSet.has(email) && !!email);
        if (missingEmails.length === 0) {
            logger.info('[Sync] No new remote accounts; skipped get_accounts_with_tokens (plaintext tokens not pulled)');
        } else {
            const missingSet = new Set(missingEmails);
            const tokenAccounts = await fetchRemoteAccountsWithTokens();
            for (const account of tokenAccounts) {
                if (!missingSet.has(account.email)) {
                    continue;
                }
                if (!account.refresh_token) {
                    logger.info(`[Sync] Skip import (missing refresh_token): ${account.email}`);
                    continue;
                }

                const credential = oauthService.buildCredentialFromTokenData({
                    email: account.email,
                    accessToken: account.access_token || '',
                    refreshToken: account.refresh_token,
                    expiresAt: toIsoFromUnixSeconds(account.expires_at),
                    projectId: account.project_id ?? undefined,
                    isInvalid: account.disabled,
                });

                await credentialStorage.saveCredentialForAccount(account.email, credential, { skipNotifyTools: true });
                localSet.add(account.email);
                localChanged = true;
                logger.info(`[Sync] Import from Tools: ${account.email}`);
            }
        }

        await credentialStorage.setToolsAccountSnapshot(remoteEmails);

        if (localChanged) {
            cockpitToolsSyncEvents.emit('localChanged', {
                reason: options?.reason,
            });
            logger.info('[Sync] Local changed, notify webview');
        }
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`[Sync] 双向同步失败: ${err.message}`);
        if (err.message.includes('请求超时')) {
            logger.warn('[Sync] 可能是桌面端未升级到支持 accounts_with_tokens 的版本');
        }
    } finally {
        syncInProgress = false;
    }
}
