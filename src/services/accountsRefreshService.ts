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
import { QuotaRefreshManager } from './quotaRefreshManager';

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
    isForbidden?: boolean;      // 403 无权限（跳过自动刷新）
    forbiddenReason?: string;   // 无权限原因（用于UI显示）
    expiresAt?: string;         // Token 过期时间
}

export class AccountsRefreshService {
    private accounts: Map<string, AccountState> = new Map();
    private quotaCache: Map<string, AccountQuotaCache> = new Map();
    private currentEmail: string | null = null;
    private initialized = false;
    private initError: string | null = null;
    private toolsAvailable = false;

    private refreshTimer?: ReturnType<typeof setTimeout>;
    private lastManualRefresh = 0;
    private static readonly MANUAL_REFRESH_COOLDOWN_MS = 10000;
    private static readonly STARTUP_WS_WAIT_MS = 5000;
    private isRefreshingQuotas = false;
    private refreshInFlight: Promise<void> | null = null;
    private startupRefreshPromise: Promise<void> | null = null;

    private readonly onDidUpdateEmitter = new vscode.EventEmitter<void>();
    readonly onDidUpdate = this.onDidUpdateEmitter.event;

    /** 配额刷新管理器（统一入口） */
    private readonly quotaRefreshManager: QuotaRefreshManager;

    constructor(private readonly reactor: ReactorCore) {
        this.quotaRefreshManager = new QuotaRefreshManager(reactor);
        this.scheduleNextAutoRefresh();
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
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
        await this.refresh({ reason: 'manualRefresh', allowForbidden: true });
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

    async refresh(options?: { forceSync?: boolean; skipSync?: boolean; skipQuotaRefresh?: boolean; reason?: string; allowForbidden?: boolean }): Promise<void> {
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
                const allowForbidden = options?.allowForbidden ?? false;
                if (!options?.skipQuotaRefresh) {
                    const emails: string[] = [];
                    for (const [email, account] of this.accounts) {
                        if (!account.hasPluginCredential) {
                            this.setMissingCredentialCache(email);
                            continue;
                        }
                        if (account.isInvalid) {
                            this.setErrorCache(email, account.invalidReason || t('accountsRefresh.authExpired'));
                            continue;
                        }
                        if (account.isForbidden && !allowForbidden) {
                            this.setForbiddenCache(email);
                            continue;
                        }
                        emails.push(email);
                    }
                    
                    // 使用 QuotaRefreshManager 批量刷新（走文件缓存）
                    const results = await this.quotaRefreshManager.refreshAccounts(emails, { reason: reason });
                    
                    // 将结果同步到内存缓存
                    for (const [email, result] of results) {
                        if (result.success && result.snapshot) {
                            const cache: AccountQuotaCache = {
                                snapshot: result.snapshot,
                                fetchedAt: Date.now(),
                                loading: false,
                                error: undefined,
                            };
                            this.quotaCache.set(email, cache);
                            await this.clearAccountForbiddenState(email);
                        } else if (!result.success) {
                            if (result.error && this.isForbiddenError(result.error)) {
                                await this.setAccountForbiddenState(email);
                                if (allowForbidden) {
                                    this.setErrorCache(email, result.error || '403 Forbidden');
                                } else {
                                    this.setForbiddenCache(email);
                                }
                            } else {
                                this.setErrorCache(email, result.error || 'Unknown error');
                            }
                        }
                    }
                    this.emitUpdate();
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
            // 使用 QuotaRefreshManager 批量刷新（走文件缓存）
            const emails: string[] = [];
            for (const [email, account] of this.accounts) {
                if (!account.hasPluginCredential) {
                    this.setMissingCredentialCache(email);
                    continue;
                }
                if (account.isInvalid) {
                    this.setErrorCache(email, account.invalidReason || t('accountsRefresh.authExpired'));
                    continue;
                }
                if (account.isForbidden) {
                    this.setForbiddenCache(email);
                    continue;
                }
                emails.push(email);
            }

            const results = await this.quotaRefreshManager.refreshAccounts(emails, { reason: 'autoRefresh' });
            
            // 将结果同步到内存缓存
            for (const [email, result] of results) {
                if (result.success && result.snapshot) {
                    const cache: AccountQuotaCache = {
                        snapshot: result.snapshot,
                        fetchedAt: Date.now(),
                        loading: false,
                        error: undefined,
                    };
                    this.quotaCache.set(email, cache);
                    await this.clearAccountForbiddenState(email);
                } else if (!result.success) {
                    if (result.error && this.isForbiddenError(result.error)) {
                        await this.setAccountForbiddenState(email);
                        this.setForbiddenCache(email);
                    } else {
                        this.setErrorCache(email, result.error || 'Unknown error');
                    }
                    
                    // 检查是否为授权失败
                    if (result.error && this.isAuthError(result.error)) {
                        const account = this.accounts.get(email);
                        if (account) {
                            account.isInvalid = true;
                            account.invalidReason = t('accountsRefresh.authExpired');
                        }
                    }
                }
            }
            
            this.emitUpdate();
        } finally {
            this.isRefreshingQuotas = false;
        }
    }

    /**
     * 检查错误是否为授权失败
     */
    private isAuthError(error: string): boolean {
        return error.includes('Authorization expired') 
            || error.includes('invalid_grant')
            || error.includes('401')
            || error.includes('UNAUTHENTICATED')
            || error.includes('invalid authentication credentials')
            || error.includes('Expected OAuth 2 access token');
    }

    private isForbiddenError(error: string): boolean {
        const normalized = error.toLowerCase();
        return normalized.includes('403') || normalized.includes('forbidden');
    }

    /**
     * 加载单个账号的配额（强制刷新，忽略缓存）
     * 用于：账号卡片点击刷新、主页面刷新按钮
     */
    async loadAccountQuota(email: string): Promise<void> {
        const account = this.accounts.get(email);
        if (account && !account.hasPluginCredential) {
            this.setMissingCredentialCache(email);
            this.emitUpdate();
            return;
        }

        // 设置 loading 状态
        const cache = this.quotaCache.get(email) || {
            snapshot: { timestamp: new Date(), models: [], isConnected: false },
            fetchedAt: 0,
        };
        cache.loading = true;
        cache.error = undefined;
        this.quotaCache.set(email, cache);
        this.emitUpdate();

        // 使用 QuotaRefreshManager 强制刷新（忽略缓存）
        const result = await this.quotaRefreshManager.refreshAccount(email, {
            forceRefresh: true,
            reason: 'manualSingle',
        });

        if (result.success && result.snapshot) {
            cache.snapshot = result.snapshot;
            cache.fetchedAt = Date.now();
            cache.loading = false;
            cache.error = undefined;
            await this.clearAccountForbiddenState(email);
            logger.info(`[AccountsRefresh] Loaded quota for ${email}: ${result.snapshot.models.length} models, ${result.snapshot.groups?.length ?? 0} groups`);
        } else {
            cache.loading = false;
            if (result.error && this.isForbiddenError(result.error)) {
                await this.setAccountForbiddenState(email);
                cache.error = result.error || '403 Forbidden';
            } else {
                cache.error = result.error || 'Unknown error';
            }
            logger.error(`[AccountsRefresh] Failed to load quota for ${email}:`, result.error);
            
            // 检查是否为授权失败
            if (result.error && this.isAuthError(result.error)) {
                if (account) {
                    account.isInvalid = true;
                    account.invalidReason = t('accountsRefresh.authExpired');
                }
            }
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

    /**
     * 计算下一次自动刷新的间隔（含随机偏移）
     * 规则：
     * - 设置间隔 ≥ 30秒：随机 [-10秒, +10秒] 偏移
     * - 设置间隔 < 30秒：随机 [0秒, +10秒] 偏移（只加不减）
     */
    private calculateNextRefreshInterval(): number {
        const baseIntervalMs = configService.getRefreshIntervalMs();
        const baseSeconds = baseIntervalMs / 1000;

        let offsetMs: number;
        if (baseSeconds >= 30) {
            // 30秒及以上：-10到+10秒随机
            offsetMs = (Math.random() * 20 - 10) * 1000;
        } else {
            // 30秒以下：0到+10秒随机（只加不减）
            offsetMs = Math.random() * 10 * 1000;
        }

        // 确保最小间隔为 5 秒
        return Math.max(5000, baseIntervalMs + offsetMs);
    }

    /**
     * 调度下一次自动刷新
     * 使用动态 setTimeout 替代固定 setInterval，每次刷新后重新计算下一次间隔
     */
    private scheduleNextAutoRefresh(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }

        const nextIntervalMs = this.calculateNextRefreshInterval();
        const baseIntervalMs = configService.getRefreshIntervalMs();
        logger.info(`[AccountsRefresh] Next auto refresh in ${Math.round(nextIntervalMs / 1000)}s (base: ${baseIntervalMs / 1000}s)`);

        this.refreshTimer = setTimeout(() => {
            void this.refreshQuotas().finally(() => {
                // 刷新完成后调度下一次
                this.scheduleNextAutoRefresh();
            });
        }, nextIntervalMs);
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
                isForbidden: credential?.isForbidden ?? false,
                forbiddenReason: credential?.isForbidden ? t('accountsRefresh.forbidden') : undefined,
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
                isForbidden: credential?.isForbidden ?? false,
                forbiddenReason: credential?.isForbidden ? t('accountsRefresh.forbidden') : undefined,
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

        if (account.isForbidden) {
            return {
                canRefresh: false,
                skipReason: account.forbiddenReason || t('accountsRefresh.forbidden'),
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

    private setForbiddenCache(email: string): void {
        const cache: AccountQuotaCache = {
            snapshot: { timestamp: new Date(), models: [], isConnected: false },
            fetchedAt: Date.now(),
            loading: false,
            error: t('accountsRefresh.forbidden'),
        };
        this.quotaCache.set(email, cache);
        this.emitUpdate();
    }

    private async setAccountForbiddenState(email: string): Promise<void> {
        const account = this.accounts.get(email);
        if (account) {
            account.isForbidden = true;
            account.forbiddenReason = t('accountsRefresh.forbidden');
        }
        await credentialStorage.markAccountForbidden(email, true);
        this.emitUpdate();
        logger.warn(`[AccountsRefresh] Account ${email} marked as forbidden (403)`);
    }

    private async clearAccountForbiddenState(email: string): Promise<void> {
        const account = this.accounts.get(email);
        if (account?.isForbidden) {
            account.isForbidden = false;
            account.forbiddenReason = undefined;
            await credentialStorage.clearAccountForbidden(email);
            this.emitUpdate();
            logger.info(`[AccountsRefresh] Cleared forbidden status for ${email}`);
        }
    }

    /**
     * @deprecated 已被 QuotaRefreshManager 替代，保留以备回退
     */
    private async silentLoadAccountQuota(email: string): Promise<void> {
        // 统一检查
        const { canRefresh, skipReason } = this.checkAccountRefreshable(email);
        
        if (!canRefresh) {
            // 直接设置错误缓存，跳过网络请求
            this.setErrorCache(email, skipReason!);
            return;
        }

        try {
            const { snapshot, fromApiCacheFile } = await this.reactor.fetchQuotaForAccountWithSource(email);
            const cache: AccountQuotaCache = {
                snapshot,
                fetchedAt: Date.now(),
                loading: false,
                error: undefined,
            };
            this.quotaCache.set(email, cache);
            if (!fromApiCacheFile) {
                void recordQuotaHistory(email, snapshot);
            }
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
