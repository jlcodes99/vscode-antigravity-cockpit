/**
 * Antigravity Cockpit - 配额刷新管理器
 * 统一管理所有配额刷新请求，实现文件缓存和防重复刷新
 */

import { logger } from '../shared/log_service';
import { ReactorCore } from '../engine/reactor';
import { QuotaSnapshot } from '../shared/types';
import { readQuotaApiCache, isApiCacheValid, getApiCacheAge } from './quota_api_cache';
import { credentialStorage } from '../auto_trigger';
import { recordQuotaHistory } from './quota_history';

export interface RefreshOptions {
    /** 是否强制刷新（忽略缓存） */
    forceRefresh?: boolean;
    /** 刷新原因（用于日志） */
    reason?: string;
}

export interface RefreshResult {
    /** 是否成功 */
    success: boolean;
    /** 是否使用了缓存 */
    fromCache: boolean;
    /** 配额快照 */
    snapshot?: QuotaSnapshot;
    /** 错误信息 */
    error?: string;
}

/**
 * 配额刷新管理器
 * 负责统一管理配额刷新，实现跨工作区/IDE 的文件缓存共享
 */
export class QuotaRefreshManager {
    /** 当前正在刷新的账号（防止并发） */
    private refreshingAccounts = new Set<string>();
    /** 最近一次网络刷新时间（仅在成功网络请求后更新） */
    private lastNetworkRefreshAt = new Map<string, number>();

    constructor(private readonly reactor: ReactorCore) {}

    /**
     * 刷新单个账号的配额
     * @param email 账号邮箱
     * @param options 刷新选项
     * @returns 刷新结果
     */
    async refreshAccount(email: string, options?: RefreshOptions): Promise<RefreshResult> {
        const reason = options?.reason ?? 'manual';
        const forceRefresh = options?.forceRefresh ?? false;

        while (this.refreshingAccounts.has(email)) {
            logger.debug(`[QuotaRefresh] Account ${email} is already refreshing, waiting...`);
            const waitStartedAt = Date.now();
            await this.waitForRefresh(email);
            const cachedSnapshot = await this.tryUseApiCache(email, reason, waitStartedAt, forceRefresh);
            if (cachedSnapshot) {
                return {
                    success: true,
                    fromCache: true,
                    snapshot: cachedSnapshot,
                };
            }
        }

        try {
            this.refreshingAccounts.add(email);

            if (!forceRefresh) {
                const cachedSnapshot = await this.tryUseApiCache(email, reason);
                if (cachedSnapshot) {
                    return {
                        success: true,
                        fromCache: true,
                        snapshot: cachedSnapshot,
                    };
                }
            }

            // 2. 缓存无效或强制刷新，发起网络请求
            logger.info(`[QuotaRefresh] Fetching quota for ${email} from network (force: ${forceRefresh}, reason: ${reason})`);
            
            const { snapshot, fromApiCacheFile } = await this.reactor.fetchQuotaForAccountWithSource(email, { forceRefresh });
            this.lastNetworkRefreshAt.set(email, Date.now());
            
            // 3. 记录历史
            if (!fromApiCacheFile) {
                void recordQuotaHistory(email, snapshot);
            } else {
                logger.debug(`[QuotaRefresh] Skip history record for ${email} because data comes from api cache file`);
            }

            logger.info(`[QuotaRefresh] Refreshed ${email}: ${snapshot.models.length} models`);
            
            return {
                success: true,
                fromCache: false,
                snapshot,
            };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            logger.error(`[QuotaRefresh] Failed to refresh ${email}: ${error}`);
            
            return {
                success: false,
                fromCache: false,
                error,
            };
        } finally {
            this.refreshingAccounts.delete(email);
        }
    }

    /**
     * 批量刷新多个账号（走缓存）
     * @param emails 账号邮箱列表
     * @param options 刷新选项
     * @returns 各账号的刷新结果
     */
    async refreshAccounts(emails: string[], options?: RefreshOptions): Promise<Map<string, RefreshResult>> {
        const results = new Map<string, RefreshResult>();
        const reason = options?.reason ?? 'batch';

        for (const email of emails) {
            const result = await this.refreshAccount(email, { 
                ...options, 
                reason,
                // 批量刷新默认走缓存，除非明确指定 forceRefresh
                forceRefresh: options?.forceRefresh ?? false,
            });
            results.set(email, result);
        }

        return results;
    }

    /**
     * 刷新所有已授权的账号
     * @param options 刷新选项
     * @returns 各账号的刷新结果
     */
    async refreshAll(options?: RefreshOptions): Promise<Map<string, RefreshResult>> {
        const credentials = await credentialStorage.getAllCredentials();
        const emails = Object.keys(credentials).filter(email => {
            const cred = credentials[email];
            return cred && !cred.isInvalid && !cred.isForbidden;
        });

        logger.info(`[QuotaRefresh] Refreshing all ${emails.length} accounts (reason: ${options?.reason ?? 'all'})`);
        return this.refreshAccounts(emails, options);
    }

    /**
     * 等待指定账号的刷新完成
     */
    private async waitForRefresh(email: string, timeoutMs: number = 30000): Promise<void> {
        const startTime = Date.now();
        while (this.refreshingAccounts.has(email)) {
            if (Date.now() - startTime > timeoutMs) {
                throw new Error(`Timeout waiting for refresh of ${email}`);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    private async tryUseApiCache(
        email: string,
        reason: string,
        waitStartedAt?: number,
        forceRefresh?: boolean,
    ): Promise<QuotaSnapshot | null> {
        const cached = await readQuotaApiCache('authorized', email);
        if (!isApiCacheValid(cached)) {
            return null;
        }
        if (forceRefresh && waitStartedAt !== undefined) {
            const lastNetworkAt = this.lastNetworkRefreshAt.get(email);
            if (lastNetworkAt === undefined || lastNetworkAt < waitStartedAt) {
                return null;
            }
        }
        const age = getApiCacheAge(cached);
        logger.info(`[QuotaRefresh] Using api cache for ${email} (age: ${Math.round(age / 1000)}s, reason: ${reason})`);
        return this.reactor.buildAuthorizedSnapshotFromResponse(cached!.payload, cached!.updatedAt);
    }
}
