import * as vscode from 'vscode';
import { logger } from '../shared/log_service';
import { credentialStorage } from '../auto_trigger/credential_storage';
import { ReactorCore } from '../engine/reactor';
import { cockpitToolsWs, AccountInfo } from './cockpitToolsWs';
import { syncAccountsWithCockpitTools } from './cockpitToolsSync';
import { configService } from '../shared/config_service';
import { QuotaSnapshot } from '../shared/types';
import { t } from '../shared/i18n';
import { recordQuotaHistory } from './quota_history';

export interface AccountQuotaCache {
    snapshot: QuotaSnapshot;
    fetchedAt: number;
    loading?: boolean;
    error?: string;
}

export interface AccountState {
    email: string;
    toolsId: string | null;
    isCurrent: boolean;
    hasDeviceBound: boolean;
    hasPluginCredential: boolean;
    tier?: string;
    // 异常状态（从 credentialStorage 同步）
    isInvalid?: boolean;        // Token 失效（需重新授权）
    invalidReason?: string;     // 失效原因（用于UI显示）
    expiresAt?: string;         // Token 过期时间
}

export class AccountsRefreshService {
    private accounts: Map<string, AccountState> = new Map();
    private quotaCache: Map<string, AccountQuotaCache> = new Map();
    private currentEmail: string | null = null;
    private initialized = false;
    private initError: string | null = null;
    private toolsAvailable = false;

    private refreshTimer?: ReturnType<typeof setInterval>;
    private lastManualRefresh = 0;
    private static readonly MANUAL_REFRESH_COOLDOWN_MS = 10000;
    private static readonly STARTUP_WS_WAIT_MS = 5000;
    private isRefreshingQuotas = false;
    private refreshInFlight: Promise<void> | null = null;
    private startupRefreshPromise: Promise<void> | null = null;

    private readonly onDidUpdateEmitter = new vscode.EventEmitter<void>();
    readonly onDidUpdate = this.onDidUpdateEmitter.event;

    constructor(private readonly reactor: ReactorCore) {
        this.startAutoRefresh();
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        this.onDidUpdateEmitter.dispose();
    }

    getAccountsMap(): ReadonlyMap<string, AccountState> {
        return this.accounts;
    }

    getQuotaCacheMap(): ReadonlyMap<string, AccountQuotaCache> {
        return this.quotaCache;
    }

    getAccount(email: string): AccountState | undefined {
        return this.accounts.get(email);
    }

    getQuotaCache(email: string): AccountQuotaCache | undefined {
        return this.quotaCache.get(email);
    }

    getCurrentEmail(): string | null {
        return this.currentEmail;
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    getInitError(): string | null {
        return this.initError;
    }

    isToolsAvailable(): boolean {
        return this.toolsAvailable;
    }

    /**
     * 供管理弹框使用，兼容原有格式
     * 替代 credentialStorage.getAccountInfoList()
     */
    getAccountInfoList(): Array<{
        email: string;
        isActive: boolean;
        expiresAt?: string;
        isInvalid?: boolean;
    }> {
        const result = [];
        for (const [email, state] of this.accounts) {
            result.push({
                email,
                isActive: state.isCurrent,
                expiresAt: state.expiresAt,
                isInvalid: state.isInvalid,
            });
        }
        return result;
    }

    async manualRefresh(): Promise<boolean> {
        const now = Date.now();
        const elapsed = now - this.lastManualRefresh;
        const remaining = AccountsRefreshService.MANUAL_REFRESH_COOLDOWN_MS - elapsed;

        if (remaining > 0) {
            const seconds = Math.ceil(remaining / 1000);
            vscode.window.showWarningMessage(t('accountsRefresh.refreshCooldown', { seconds: seconds.toString() }));
            return false;
        }

        this.lastManualRefresh = now;
        await this.refresh();
        return true;
    }

    async refreshOnStartup(waitMs: number = AccountsRefreshService.STARTUP_WS_WAIT_MS): Promise<void> {
        if (this.startupRefreshPromise) {
            return this.startupRefreshPromise;
        }

        this.startupRefreshPromise = (async () => {
            if (!cockpitToolsWs.isConnected) {
                await new Promise<void>((resolve) => {
                    let settled = false;
                    const finish = () => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        cockpitToolsWs.removeListener('connected', onConnected);
                        clearTimeout(timeoutId);
                        resolve();
                    };
                    const onConnected = () => {
                        finish();
                    };
                    const timeoutId = setTimeout(finish, waitMs);
                    cockpitToolsWs.on('connected', onConnected);
                    if (cockpitToolsWs.isConnected) {
                        finish();
                    }
                });
            }
            await this.refresh({ reason: 'startup' });
        })();

        return this.startupRefreshPromise;
    }

    async refresh(options?: { forceSync?: boolean; skipSync?: boolean; skipQuotaRefresh?: boolean; reason?: string }): Promise<void> {
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }

        this.refreshInFlight = (async () => {
            this.initError = null;
            this.emitUpdate();

            try {
                const reason = options?.reason ?? 'accountsRefresh.refresh';
                if (!options?.skipSync) {
                    await syncAccountsWithCockpitTools({ reason, force: options?.forceSync });
                }

                if (cockpitToolsWs.isConnected) {
                    await this.loadAccountsFromWebSocket();
                } else {
                    await this.loadAccountsFromSharedFile();
                }

                this.initialized = true;
                logger.info(`[AccountsRefresh] Loaded ${this.accounts.size} accounts, tools available: ${this.toolsAvailable}`);
                this.emitUpdate();

                // 刷新配额（可选跳过）
                if (!options?.skipQuotaRefresh) {
                    for (const [email, account] of this.accounts) {
                        if (!account.hasPluginCredential) {
                            this.setMissingCredentialCache(email);
                            continue;
                        }
                        await this.silentLoadAccountQuota(email);
                    }
                } else {
                    logger.info('[AccountsRefresh] 跳过配额刷新 (skipQuotaRefresh=true)');
                }
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                this.initError = t('accountsRefresh.loadFailed', { error });
                this.toolsAvailable = false;
                this.initialized = true;
                logger.error('[AccountsRefresh] Failed to load accounts:', error);
                this.emitUpdate();
            }
        })();

        try {
            await this.refreshInFlight;
        } finally {
            this.refreshInFlight = null;
        }
    }

    async refreshQuotas(): Promise<void> {
        if (this.refreshInFlight) {
            await this.refreshInFlight;
            return;
        }

        // 配额刷新不依赖 Cockpit Tools，只需要插件自身的凭证即可

        if (this.isRefreshingQuotas) {
            logger.debug('[AccountsRefresh] Quota refresh already in progress, skipping');
            return;
        }

        this.isRefreshingQuotas = true;
        try {
            for (const [email, account] of this.accounts) {
                if (!account.hasPluginCredential) {
                    this.setMissingCredentialCache(email);
                    continue;
                }
                await this.silentLoadAccountQuota(email);
            }
        } finally {
            this.isRefreshingQuotas = false;
        }
    }

    async loadAccountQuota(email: string): Promise<void> {
        const account = this.accounts.get(email);
        if (account && !account.hasPluginCredential) {
            this.setMissingCredentialCache(email);
            this.emitUpdate();
            return;
        }

        const cache = this.quotaCache.get(email) || {
            snapshot: { timestamp: new Date(), models: [], isConnected: false },
            fetchedAt: 0,
        };
        cache.loading = true;
        cache.error = undefined;
        this.quotaCache.set(email, cache);
        this.emitUpdate();

        try {
            const snapshot = await this.reactor.fetchQuotaForAccount(email);
            cache.snapshot = snapshot;
            cache.fetchedAt = Date.now();
            cache.loading = false;
            cache.error = undefined;
            void recordQuotaHistory(email, snapshot);
            logger.info(`[AccountsRefresh] Loaded quota for ${email}: ${snapshot.models.length} models, ${snapshot.groups?.length ?? 0} groups`);
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            cache.loading = false;
            cache.error = error;
            logger.error(`[AccountsRefresh] Failed to load quota for ${email}:`, error);
        }

        this.quotaCache.set(email, cache);
        this.emitUpdate();
    }

    async getAccountId(email: string): Promise<string | null> {
        const cached = this.accounts.get(email);
        if (cached?.toolsId) {
            return cached.toolsId;
        }

        if (!this.toolsAvailable || !cockpitToolsWs.isConnected) {
            return null;
        }

        try {
            const resp = await cockpitToolsWs.getAccounts();
            const acc = resp.accounts.find((a: AccountInfo) => a.email === email);
            return acc?.id ?? null;
        } catch {
            return null;
        }
    }

    private startAutoRefresh(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }

        const intervalMs = configService.getRefreshIntervalMs();
        logger.info(`[AccountsRefresh] Starting auto refresh, interval: ${intervalMs}ms`);

        this.refreshTimer = setInterval(() => {
            void this.refreshQuotas();
        }, intervalMs);
    }

    private async loadAccountsFromWebSocket(): Promise<void> {
        this.toolsAvailable = true;

        const toolsResp = await cockpitToolsWs.getAccounts();
        const toolsAccounts = toolsResp.accounts ?? [];

        const credentials = await credentialStorage.getAllCredentials();
        const pluginEmails = new Set(Object.keys(credentials));

        this.accounts.clear();

        let currentEmail: string | null = null;

        for (const acc of toolsAccounts) {
            const isCurrent = acc.is_current || (toolsResp.current_account_id ? acc.id === toolsResp.current_account_id : false);
            if (isCurrent) {
                currentEmail = acc.email;
            }

            // 读取该账号的凭证状态
            const credential = credentials[acc.email];

            this.accounts.set(acc.email, {
                email: acc.email,
                toolsId: acc.id ?? null,
                isCurrent,
                hasDeviceBound: acc.has_fingerprint,
                hasPluginCredential: pluginEmails.has(acc.email),
                tier: this.extractTierFromAccount(acc as unknown as { [key: string]: unknown }),
                // 合并凭证异常状态
                isInvalid: credential?.isInvalid ?? false,
                invalidReason: credential?.isInvalid ? t('accountsRefresh.authExpired') : undefined,
                expiresAt: credential?.expiresAt,
            });
        }

        this.currentEmail = currentEmail;
        this.cleanupQuotaCache();
    }

    private async loadAccountsFromSharedFile(): Promise<void> {
        this.toolsAvailable = false;

        const credentials = await credentialStorage.getAllCredentials();
        const pluginEmails = Object.keys(credentials);

        if (pluginEmails.length === 0) {
            this.accounts.clear();
            this.currentEmail = null;
            this.initError = t('accountsRefresh.noAccounts');
            return;
        }

        let currentEmailFromFile: string | null = null;
        try {
            const os = await import('os');
            const path = await import('path');
            const fs = await import('fs');

            const sharedDir = path.join(os.homedir(), '.antigravity_cockpit');
            const currentAccountFile = path.join(sharedDir, 'current_account.json');

            if (fs.existsSync(currentAccountFile)) {
                const content = fs.readFileSync(currentAccountFile, 'utf-8');
                const data = JSON.parse(content) as { email?: string };
                if (data.email && pluginEmails.includes(data.email)) {
                    currentEmailFromFile = data.email;
                }
            }
        } catch {
            // ignore
        }

        this.accounts.clear();
        for (const email of pluginEmails) {
            const isCurrent = email === currentEmailFromFile;
            const credential = credentials[email];
            
            this.accounts.set(email, {
                email,
                toolsId: null,
                isCurrent,
                hasDeviceBound: false,
                hasPluginCredential: true,
                // 合并凭证异常状态
                isInvalid: credential?.isInvalid ?? false,
                invalidReason: credential?.isInvalid ? t('accountsRefresh.authExpired') : undefined,
                expiresAt: credential?.expiresAt,
            });
        }

        this.currentEmail = currentEmailFromFile;
        this.cleanupQuotaCache();
    }

    private cleanupQuotaCache(): void {
        const validEmails = new Set(this.accounts.keys());
        for (const email of this.quotaCache.keys()) {
            if (!validEmails.has(email)) {
                this.quotaCache.delete(email);
            }
        }
    }

    /**
     * 统一判断：账号是否可刷新配额
     * 所有刷新逻辑调用这个方法，避免重复判断
     */
    private checkAccountRefreshable(email: string): {
        canRefresh: boolean;
        skipReason?: string;
    } {
        const account = this.accounts.get(email);
        
        // 1. 没有插件凭证
        if (!account?.hasPluginCredential) {
            return { 
                canRefresh: false, 
                skipReason: t('accountsRefresh.notImported'), 
            };
        }
        
        // 2. 已标记为失效
        if (account.isInvalid) {
            return { 
                canRefresh: false, 
                skipReason: account.invalidReason || t('accountsRefresh.authExpired'), 
            };
        }
        
        return { canRefresh: true };
    }

    private setErrorCache(email: string, error: string): void {
        const cache: AccountQuotaCache = {
            snapshot: { timestamp: new Date(), models: [], isConnected: false },
            fetchedAt: Date.now(),
            loading: false,
            error,
        };
        this.quotaCache.set(email, cache);
        this.emitUpdate();
    }

    private async silentLoadAccountQuota(email: string): Promise<void> {
        // 统一检查
        const { canRefresh, skipReason } = this.checkAccountRefreshable(email);
        
        if (!canRefresh) {
            // 直接设置错误缓存，跳过网络请求
            this.setErrorCache(email, skipReason!);
            return;
        }

        try {
            const snapshot = await this.reactor.fetchQuotaForAccount(email);
            const cache: AccountQuotaCache = {
                snapshot,
                fetchedAt: Date.now(),
                loading: false,
                error: undefined,
            };
            this.quotaCache.set(email, cache);
            void recordQuotaHistory(email, snapshot);
            this.emitUpdate();
            logger.info(`[AccountsRefresh] Refreshed quota for ${email}: ${snapshot.models.length} models, ${snapshot.groups?.length ?? 0} groups`);
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            
            // 判断是否为授权失败错误（多种情况）
            const isAuthError = error.includes('Authorization expired') 
                || error.includes('invalid_grant')
                || error.includes('401')
                || error.includes('UNAUTHENTICATED')
                || error.includes('invalid authentication credentials')
                || error.includes('Expected OAuth 2 access token');
            
            if (isAuthError) {
                const account = this.accounts.get(email);
                if (account) {
                    account.isInvalid = true;
                    account.invalidReason = t('accountsRefresh.authExpired');
                    this.emitUpdate();
                    logger.warn(`[AccountsRefresh] Account ${email} marked as invalid due to auth error: ${error.substring(0, 100)}`);
                }
            }
            
            logger.debug(`[AccountsRefresh] Silent refresh failed for ${email}: ${error}`);
        }
    }

    private setMissingCredentialCache(email: string): void {
        const cache: AccountQuotaCache = {
            snapshot: { timestamp: new Date(), models: [], isConnected: false },
            fetchedAt: Date.now(),
            loading: false,
            error: t('accountsRefresh.notImported'),
        };
        this.quotaCache.set(email, cache);
        this.emitUpdate();
    }

    private extractTierFromAccount(account: { [key: string]: unknown }): string | undefined {
        const tier = account.subscription_tier
            || account.subscriptionTier
            || account.tier;
        return typeof tier === 'string' && tier.trim() ? tier.trim() : undefined;
    }

    private emitUpdate(): void {
        this.onDidUpdateEmitter.fire();
    }
}
