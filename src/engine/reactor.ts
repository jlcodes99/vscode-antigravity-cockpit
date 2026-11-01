/**
 * Antigravity Cockpit - 反应堆核心
 * 负责与 Antigravity API 通信，获取配额数据
 */

import * as https from 'https';
import { 
    QuotaSnapshot,
    ModelQuotaInfo,
    PromptCreditsInfo,
    ServerUserStatusResponse,
    ClientModelConfig,
    ScanDiagnostics,
    UserInfo,
} from '../shared/types';
import { logger } from '../shared/log_service';
import { configService } from '../shared/config_service';
import { t } from '../shared/i18n';
import { TIMING, API_ENDPOINTS } from '../shared/constants';
import { AntigravityError } from '../shared/errors';
import { cloudCodeClient, CloudCodeAuthError, CloudCodeRequestError } from '../shared/cloudcode_client';
import { autoTriggerController } from '../auto_trigger/controller';
import { oauthService, credentialStorage } from '../auto_trigger';
import { antigravityToolsSyncService } from '../antigravityTools_sync';
import {
    readQuotaApiCache,
    writeQuotaApiCache,
    isApiCacheValid,
    type QuotaApiCacheRecord,
} from '../services/quota_api_cache';
import { AUTH_MODEL_BLACKLIST_IDS } from '../shared/recommended_models';
import {
    computeModelAdoption,
    type AuthorizedQuotaResponse,
    type AuthorizedModelInfo,
} from './model_catalog';
import {
    resolveModelFamily,
    buildFamilyGroupMap,
    calculateSmartGrouping,
    type ModelFamily as AutoGroupFamily,
} from './model_family';
import { assembleSnapshotModels } from './snapshot_builder';
import { mapAuthorizedResponseToModels, mapLocalConfigsToModels } from './quota_mapper';

export type { AuthorizedQuotaResponse, AuthorizedModelInfo };

export interface AccountQuotaFetchResult {
    snapshot: QuotaSnapshot;
    fromApiCacheFile: boolean;
}

const AUTH_MODEL_BLACKLIST_ID_SET = new Set(AUTH_MODEL_BLACKLIST_IDS);

/** globalState key：已见过的模型 ID，用于识别官方新上线的模型 */
const KNOWN_MODEL_IDS_STATE_KEY = 'knownModelIds';

/**
 * 反应堆核心类
 * 管理与后端 API 的通信
 */
export class ReactorCore {
    private port: number = 0;
    private token: string = '';

    private updateHandler?: (data: QuotaSnapshot) => void;
    private errorHandler?: (error: Error) => void;
    private pulseTimer?: ReturnType<typeof setInterval>;
    public currentInterval: number = 0;
    private lastScanDiagnostics?: ScanDiagnostics;
    
    /** 上一次的配额快照缓存 */
    private lastSnapshot?: QuotaSnapshot;
    /** 上一次快照的来源 */
    private lastSnapshotSource?: 'local' | 'authorized';
    /** 上一次的原始 API 响应缓存（用于 reprocess 时重新生成分组） */
    private lastRawResponse?: ServerUserStatusResponse;
    /** 上一次的授权配额模型缓存（用于 reprocess 时重新生成分组） */
    private lastAuthorizedModels?: ModelQuotaInfo[];
    /** 最近一次成功获取到的授权 Credits（用于缓存重放时避免回退为 --） */
    private lastAuthorizedAvailableAICredits?: number;
    /** 本地配额上次拉取时间 */
    private lastLocalFetchedAt?: number;
    /** 授权配额上次拉取时间 */
    private lastAuthorizedFetchedAt?: number;
    /** 初始化同步重试标识，用于中断本地重试流程 */
    private initRetryToken: number = 0;
    /** 本地模式下的账户邮箱（从 state.vscdb 读取） */
    private localAccountEmail?: string;
    /** 本地模式是否使用远端 API */
    private localUsingRemoteApi: boolean = false;
    /** 上次记录的本地模型列表（避免重复日志） */
    private lastLoggedLocalModelList?: string;
    /** 上次记录的授权模型列表（避免重复日志） */
    private lastLoggedAuthorizedModelList?: string;
    /** 当前用户在 Antigravity 中选中的模型 ID */
    private activeModelId?: string;

    constructor() {
        logger.debug('ReactorCore Online');
    }

    /**
     * 启动反应堆，设置连接参数
     */
    engage(port: number, token: string, diagnostics?: ScanDiagnostics): void {
        this.port = port;
        this.token = token;
        this.lastScanDiagnostics = diagnostics;
        logger.info(`Reactor Engaged: :${port}`);
    }

    /**
     * 获取最新的配额快照
     */
    getLatestSnapshot(): QuotaSnapshot | undefined {
        return this.lastSnapshot;
    }

    setActiveModelId(modelId?: string): void {
        const normalized = modelId?.trim();
        const next = normalized && normalized.length > 0 ? normalized : undefined;
        if (this.activeModelId === next) {
            return;
        }
        this.activeModelId = next;
        if (this.lastSnapshot) {
            this.lastSnapshot.activeModelId = next;
        }
        if (this.updateHandler) {
            this.reprocess();
        }
    }

    public async tryUseQuotaCache(
        source: 'authorized' | 'local',
        email: string | null,
    ): Promise<boolean> {
        if (source !== 'authorized' || !email) {
            return false;
        }
        const record = await readQuotaApiCache('authorized', email);
        if (!isApiCacheValid(record)) {
            return false;
        }
        try {
            const models = this.buildModelsFromAuthorizedResponse(record!.payload as AuthorizedQuotaResponse);
            if (models.length === 0) {
                return false;
            }
            this.lastAuthorizedModels = models;
            const telemetry = this.buildSnapshot(
                models,
                undefined,
                undefined,
                this.getCachedAuthorizedAvailableAICredits(),
            );
            this.publishTelemetry(telemetry, 'authorized');
            return true;
        } catch (error) {
            logger.warn(`[QuotaApiCache] Failed to decode cached response: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * 获取指定账号的配额快照
     * 复用现有的解析、过滤、分组逻辑，确保与 Dashboard 一致
     * @param email 账号邮箱
     * @returns 配额快照
     */
    async fetchQuotaForAccount(
        email: string,
        options?: { forceRefresh?: boolean },
    ): Promise<QuotaSnapshot> {
        const result = await this.fetchQuotaForAccountWithSource(email, options);
        return result.snapshot;
    }

    public async fetchAvailableAICreditsForAccount(email: string): Promise<number | undefined> {
        try {
            const tokenStatus = await oauthService.getAccessTokenStatusForAccount(email);
            if (tokenStatus.state !== 'ok' || !tokenStatus.token) {
                return undefined;
            }

            const credential = await credentialStorage.getCredentialForAccount(email);
            const projectId = credential?.projectId;
            const info = projectId
                ? await cloudCodeClient.loadProjectInfo(tokenStatus.token, {
                    logLabel: 'AuthorizedQuota',
                    route: { isGcpTos: credential?.isGcpTos },
                })
                : await cloudCodeClient.resolveProjectId(tokenStatus.token, {
                    logLabel: 'AuthorizedQuota',
                    route: { isGcpTos: credential?.isGcpTos },
                });

            if (info.projectId) {
                await credentialStorage.updateProjectIdForAccount(email, info.projectId);
            }

            if (!Number.isFinite(info.availableAICredits)) {
                return undefined;
            }
            return Math.max(0, Number(info.availableAICredits));
        } catch (error) {
            if (error instanceof CloudCodeAuthError) {
                throw error;
            }
            const err = error instanceof Error ? error : new Error(String(error));
            logger.warn(`[AuthorizedQuota] fetch credits failed for ${email}: ${err.message}`);
            return undefined;
        }
    }

    async fetchQuotaForAccountWithSource(
        email: string,
        options?: { forceRefresh?: boolean },
    ): Promise<AccountQuotaFetchResult> {
        logger.info(`[ReactorCore] Fetching quota for account: ${email}`);

        try {
            // 获取该账号的 token
            const tokenStatus = await oauthService.getAccessTokenStatusForAccount(email);
            if (tokenStatus.state === 'invalid_grant') {
                throw new CloudCodeAuthError(`Account ${email}: Authorization expired`);
            }
            if (tokenStatus.state !== 'ok' || !tokenStatus.token) {
                throw new Error(`Account ${email}: Token unavailable (${tokenStatus.state})`);
            }

            // 获取 projectId
            const credential = await credentialStorage.getCredentialForAccount(email);
            let projectId = credential?.projectId;
            let availableAICredits: number | undefined;
            try {
                const info = projectId
                    ? await cloudCodeClient.loadProjectInfo(tokenStatus.token, {
                        logLabel: 'AuthorizedQuota',
                        route: { isGcpTos: credential?.isGcpTos },
                    })
                    : await cloudCodeClient.resolveProjectId(tokenStatus.token, {
                        logLabel: 'AuthorizedQuota',
                        route: { isGcpTos: credential?.isGcpTos },
                    });

                if (info.projectId) {
                    projectId = info.projectId;
                    await credentialStorage.updateProjectIdForAccount(email, projectId);
                }
                if (Number.isFinite(info.availableAICredits)) {
                    availableAICredits = Math.max(0, Number(info.availableAICredits));
                }
            } catch (error) {
                if (error instanceof CloudCodeAuthError) {
                    throw error;
                }
                const err = error instanceof Error ? error : new Error(String(error));
                logger.warn(`[AuthorizedQuota] loadCodeAssist failed for ${email}: ${err.message}`);
            }

            // 获取配额模型（复用现有方法）
            const modelsResult = await this.fetchAuthorizedQuotaModelsWithSource(
                tokenStatus.token,
                projectId,
                email,
                options?.forceRefresh ?? false,
                credential?.isGcpTos,
            );
            const models = modelsResult.models;

            // 构建快照（复用现有分组/过滤逻辑）
            const snapshot = this.buildSnapshot(models, undefined, undefined, availableAICredits);
            
            logger.info(`[ReactorCore] Quota for ${email}: ${models.length} models, ${snapshot.groups?.length ?? 0} groups`);
            return {
                snapshot,
                fromApiCacheFile: modelsResult.fromApiCacheFile,
            };
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            logger.error(`[ReactorCore] Failed to fetch quota for ${email}:`, error.message);
            throw error;
        }
    }

    /**
     * 发送 HTTP 请求
     */
    private async transmit<T>(endpoint: string, payload: object): Promise<T> {
        return new Promise((resolve, reject) => {
            // Guard against unengaged reactor
            if (!this.port) {
                reject(new AntigravityError('Antigravity Error: System not ready (Reactor not engaged)'));
                return;
            }

            const data = JSON.stringify(payload);
            const opts: https.RequestOptions = {
                hostname: '127.0.0.1',
                port: this.port,
                path: endpoint,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': this.token,
                },
                rejectUnauthorized: false,
                timeout: TIMING.HTTP_TIMEOUT_MS,
                agent: false, // 绕过代理，直接连接 localhost
            };

            logger.info(`Transmitting signal to ${endpoint}`, JSON.parse(data));

            const req = https.request(opts, res => {
                let body = '';
                res.on('data', c => (body += c));
                res.on('end', () => {
                    logger.info(`Signal Received (${res.statusCode}):`, {
                        statusCode: res.statusCode,
                        bodyLength: body.length,
                    });
                    // logger.debug('Signal Body:', body); // 取消注释以查看完整响应

                    // Check for empty body (often happens during process startup)
                    if (!body || body.trim().length === 0) {
                        logger.warn('Received empty response from API');
                        reject(new Error('Signal Corrupted: Empty response from server'));
                        return;
                    }

                    try {
                        resolve(JSON.parse(body) as T);
                    } catch (e) {
                        const error = e instanceof Error ? e : new Error(String(e));
                        
                        // Log body preview for diagnosis
                        const bodyPreview = body.length > 200 ? body.substring(0, 200) + '...' : body;
                        logger.error(`JSON parse failed. Response preview: ${bodyPreview}`);
                        
                        reject(new Error(`Signal Corrupted: ${error.message}`));
                    }
                });
            });

            req.on('error', (e) => reject(new Error(`Connection Failed: ${e.message}`)));
            req.on('timeout', () => {
                req.destroy();
                reject(new AntigravityError('Signal Lost: Request timed out'));
            });

            req.write(data);
            req.end();
        });
    }

    /**
     * 注册遥测数据更新回调
     */
    onTelemetry(cb: (data: QuotaSnapshot) => void): void {
        this.updateHandler = cb;
    }

    /**
     * 注册故障回调
     */
    onMalfunction(cb: (error: Error) => void): void {
        this.errorHandler = cb;
    }

    /**
     * 启动定时同步
     */
    startReactor(interval: number): void {
        this.shutdown();
        this.currentInterval = interval;
        logger.info(`Reactor Pulse: ${interval}ms`);

        // 启动时使用带重试的初始化同步，失败会自动重试
        this.initRetryToken += 1;
        const retryToken = this.initRetryToken;
        this.initWithRetry(3, 0, retryToken);

        // 定时同步（失败不重试，等下一个周期自然重试）
        this.pulseTimer = setInterval(() => {
            this.syncTelemetry();
        }, interval);
    }

    /**
     * 带重试的初始化同步
     * 仅在启动时调用，失败会自动重试，用户无感
     * @param maxRetries 最大重试次数
     * @param currentRetry 当前重试次数
     */
    private async initWithRetry(
        maxRetries: number = 3,
        currentRetry: number = 0,
        retryToken: number = this.initRetryToken,
    ): Promise<void> {
        if (retryToken !== this.initRetryToken) {
            logger.info('Init sync retry canceled');
            return;
        }
        try {
            await this.syncTelemetryCore();
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            const source = this.getSyncErrorSource(err);
            const endpoint = source === 'authorized'
                ? 'v1internal:fetchAvailableModels'
                : API_ENDPOINTS.GET_USER_STATUS;
            if (this.shouldIgnoreSyncError(err)) {
                logger.info(`[ReactorCore] Ignoring ${this.getSyncErrorSource(err)} init error after source switch: ${err.message}`);
                return;
            }
            
            if (retryToken !== this.initRetryToken) {
                logger.info('Init sync retry canceled after error');
                return;
            }
            if (currentRetry < maxRetries) {
                // 还有重试机会，使用指数退避
                const delay = 2000 * (currentRetry + 1);  // 2s, 4s, 6s
                const sourceInfo = source ? `source=${source}` : 'source=unknown';
                const endpointInfo = `endpoint=${endpoint}`;
                logger.warn(`Init sync failed (${sourceInfo}, ${endpointInfo}), retry ${currentRetry + 1}/${maxRetries} in ${delay}ms: ${err.message}`);
                
                await this.delay(delay);
                return this.initWithRetry(maxRetries, currentRetry + 1, retryToken);
            }
            
            // 超过最大重试次数，触发错误回调
            const sourceInfo = source ? `source=${source}` : 'source=unknown';
            const endpointInfo = `endpoint=${endpoint}`;
            logger.error(`Init sync failed after ${maxRetries} retries (${sourceInfo}, ${endpointInfo}): ${err.message}`);
            
            if (this.errorHandler) {
                this.errorHandler(err);
            }
        }
    }

    /**
     * 中断初始化重试流程
     */
    cancelInitRetry(): void {
        this.initRetryToken += 1;
    }

    private wrapSyncError(error: unknown, source: 'local' | 'authorized'): Error {
        const err = error instanceof Error ? error : new Error(String(error));
        (err as Error & { source?: string }).source = source;
        return err;
    }

    private getSyncErrorSource(error: Error): string | undefined {
        return (error as Error & { source?: string }).source;
    }

    private shouldIgnoreSyncError(error: Error): boolean {
        const source = this.getSyncErrorSource(error);
        if (!source) {
            return false;
        }
        const currentSource = configService.getConfig().quotaSource === 'authorized' ? 'authorized' : 'local';
        return source !== currentSource;
    }

    /**
     * 延迟指定毫秒数
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 关闭反应堆
     */
    shutdown(): void {
        if (this.pulseTimer) {
            clearInterval(this.pulseTimer);
            this.pulseTimer = undefined;
        }
    }

    /**
     * 同步遥测数据（用于定时器调用，自带错误处理）
     */
    async syncTelemetry(): Promise<void> {
        try {
            await this.syncTelemetryCore();
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            if (this.shouldIgnoreSyncError(err)) {
                logger.info(`[ReactorCore] Ignoring ${this.getSyncErrorSource(err)} sync error after source switch: ${err.message}`);
                return;
            }
            const source = this.getSyncErrorSource(err);
            const currentSource = configService.getConfig().quotaSource === 'authorized' ? 'authorized' : 'local';
            const sourceInfo = source ? `source=${source}` : 'source=unknown';
            const endpoint = source === 'authorized'
                ? 'v1internal:fetchAvailableModels'
                : API_ENDPOINTS.GET_USER_STATUS;
            logger.error(`Telemetry Sync Failed (${sourceInfo}, current=${currentSource}, endpoint=${endpoint}): ${err.message}`);
            
            if (this.errorHandler) {
                this.errorHandler(err);
            }
        }
    }

    /**
     * 同步遥测数据核心逻辑（可抛出异常，用于重试机制）
     */
    private async syncTelemetryCore(): Promise<void> {
        const config = configService.getConfig();
        if (config.quotaSource === 'authorized') {
            // 注意：移除了每次配额刷新时的自动账户切换逻辑
            // 用户可以通过"切换至当前登录账户"按钮手动触发切换
            // 这样可以避免用户手动切换账户后被自动覆盖回去的问题

            try {
                const hasAuth = await credentialStorage.hasValidCredential();
                if (!hasAuth) {
                    this.lastAuthorizedModels = undefined;
                    this.lastAuthorizedFetchedAt = undefined;
                    const telemetry = ReactorCore.createOfflineSnapshot();
                    this.publishTelemetry(telemetry, 'authorized');
                    return;
                }
                const telemetry = await this.fetchAuthorizedTelemetry();
                this.lastAuthorizedFetchedAt = Date.now();
                this.publishTelemetry(telemetry, 'authorized');
                return;
            } catch (error) {
                if (error instanceof CloudCodeAuthError) {
                    logger.warn(`[AuthorizedQuota] Authorization invalid: ${error.message}`);
                    try {
                        await credentialStorage.deleteCredential();
                    } catch (deleteError) {
                        const err = deleteError instanceof Error ? deleteError : new Error(String(deleteError));
                        logger.warn(`[AuthorizedQuota] Failed to clear credential: ${err.message}`);
                    }
                    const telemetry = ReactorCore.createOfflineSnapshot();
                    this.publishTelemetry(telemetry, 'authorized');
                    return;
                }

                if (error instanceof CloudCodeRequestError && error.status === 403) {
                    logger.warn('[AuthorizedQuota] Access forbidden (403), stopping authorized sync');
                    const telemetry = ReactorCore.createOfflineSnapshot();
                    this.publishTelemetry(telemetry, 'authorized');
                    return;
                }

                if (error instanceof CloudCodeRequestError && error.retryable) {
                    if (this.lastAuthorizedModels) {
                        const cacheAge = this.getCacheAgeMs('authorized');
                        const ageNote = cacheAge !== undefined ? ` (age=${Math.round(cacheAge / 1000)}s)` : '';
                        logger.warn(`[AuthorizedQuota] Request failed, using cached models${ageNote}`);
                        const telemetry = this.buildSnapshot(
                            this.lastAuthorizedModels,
                            undefined,
                            undefined,
                            this.getCachedAuthorizedAvailableAICredits(),
                        );
                        this.publishTelemetry(telemetry, 'authorized');
                        return;
                    }
                    const telemetry = ReactorCore.createOfflineSnapshot();
                    this.publishTelemetry(telemetry, 'authorized');
                    return;
                }

                throw this.wrapSyncError(error, 'authorized');
            }
        }

        // Local 模式：仅使用本地进程 API
        try {
            const telemetry = await this.fetchLocalTelemetryWithRemoteFallback();
            this.publishTelemetry(telemetry, 'local');
        } catch (error) {
            throw this.wrapSyncError(error, 'local');
        }
    }

    /**
     * 获取本地配额数据（仅本地进程 API）
     */
    private async fetchLocalTelemetryWithRemoteFallback(): Promise<QuotaSnapshot> {
        logger.info('[LocalQuota] Using local process API');
        this.localUsingRemoteApi = false;
        this.localAccountEmail = undefined;
        return await this.fetchLocalTelemetry();
    }

    private async fetchLocalTelemetry(): Promise<QuotaSnapshot> {
        const raw = await this.transmit<ServerUserStatusResponse>(
            API_ENDPOINTS.GET_USER_STATUS,
            {
                metadata: {
                    ideName: 'antigravity',
                    extensionName: 'antigravity',
                    locale: 'en',
                },
            },
        );
        this.lastRawResponse = raw; // 缓存原始响应
        this.lastLocalFetchedAt = Date.now();
        return this.decodeSignal(raw);
    }

    private async tryFetchLocalTelemetry(): Promise<QuotaSnapshot | null> {
        if (!this.port || !this.token) {
            return null;
        }
        try {
            return await this.fetchLocalTelemetry();
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.debug(`[LocalQuota] Local fetch failed: ${err.message}`);
            return null;
        }
    }

    private async resolveToolsAuthorizedEmail(): Promise<string | null> {
        try {
            const detection = await antigravityToolsSyncService.detect();
            if (!detection?.currentEmail) {
                return null;
            }
            return await this.resolveAuthorizedEmail(detection.currentEmail);
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.debug(`[AuthorizedQuota] Tools detection failed: ${err.message}`);
            return null;
        }
    }

    private async resolveAuthorizedEmail(localEmail: string): Promise<string | null> {
        const trimmed = localEmail.trim();
        if (!trimmed || trimmed === 'N/A' || !trimmed.includes('@')) {
            return null;
        }
        const accounts = await credentialStorage.getAllCredentials();
        const target = trimmed.toLowerCase();
        for (const email of Object.keys(accounts)) {
            if (email.toLowerCase() === target) {
                return email;
            }
        }
        return null;
    }

    private async ensureActiveAccount(email: string): Promise<void> {
        const activeAccount = await credentialStorage.getActiveAccount();
        if (activeAccount && activeAccount.toLowerCase() === email.toLowerCase()) {
            return;
        }
        await credentialStorage.setActiveAccount(email);
        logger.info(`[AuthorizedQuota] Auto-switched active account to ${email}`);
    }

    /**
     * 发布遥测数据到 UI
     */
    private publishTelemetry(telemetry: QuotaSnapshot, source?: 'local' | 'authorized'): void {
        if (source) {
            const currentSource = configService.getConfig().quotaSource === 'authorized' ? 'authorized' : 'local';
            if (source !== currentSource) {
                logger.debug(`[ReactorCore] Skipping ${source} telemetry (current source: ${currentSource})`);
                return;
            }
        }
        telemetry.activeModelId = this.activeModelId;
        this.lastSnapshot = telemetry; // Cache the latest snapshot
        if (source) {
            this.lastSnapshotSource = source;
        }

        if (telemetry.models.length > 0) {
            const maxLabelLen = Math.max(...telemetry.models.map(m => m.label.length));
            const quotaSummary = telemetry.models.map(m => {
                const pct = m.remainingPercentage !== undefined ? m.remainingPercentage.toFixed(2) + '%' : 'N/A';
                return `    ${m.label.padEnd(maxLabelLen)} : ${pct}`;
            }).join('\n');
            
            logger.info(`Quota Update:\n${quotaSummary}`);
        } else {
            logger.info('Quota Update: No models available');
        }

        if (this.updateHandler) {
            this.updateHandler(telemetry);
        }
        
        // 检查配额重置并触发自动唤醒（异步执行，不阻塞主流程）
        // 注意：现在 checkQuotaResetTrigger 会自行获取每个选中账号的配额数据
        this.checkQuotaResetTrigger().catch(err => {
            logger.warn(`[ReactorCore] Wake on reset check failed: ${err}`);
        });
    }

    /**
     * 获取授权配额并构建快照
     * @param retryCount 当前重试次数，用于防止账号切换时的无限递归
     */
    private async fetchAuthorizedTelemetry(retryCount = 0): Promise<QuotaSnapshot> {
        // 防止账号频繁切换导致的无限递归
        const MAX_ACCOUNT_CHANGE_RETRIES = 3;
        if (retryCount >= MAX_ACCOUNT_CHANGE_RETRIES) {
            logger.warn('[AuthorizedQuota] Max account change retries reached, returning empty snapshot');
            return ReactorCore.createOfflineSnapshot();
        }
        const tokenResult = await oauthService.getAccessTokenStatus();
        if (tokenResult.state === 'invalid_grant') {
            throw new CloudCodeAuthError('Authorization expired');
        }
        if (tokenResult.state === 'refresh_failed') {
            throw new CloudCodeRequestError('Token refresh failed', undefined, true);
        }
        if (tokenResult.state !== 'ok' || !tokenResult.token) {
            throw new Error(t('quotaSource.authorizedMissing') || 'Authorize auto wake-up first');
        }
        const accessToken = tokenResult.token;
        const activeAccount = await credentialStorage.getActiveAccount();

        let projectId: string | undefined;
        let availableAICredits: number | undefined;
        const credential = await credentialStorage.getCredential();
        if (credential?.projectId) {
            projectId = credential.projectId;
        }

        try {
            const info = projectId
                ? await cloudCodeClient.loadProjectInfo(accessToken, {
                    logLabel: 'AuthorizedQuota',
                    route: { isGcpTos: credential?.isGcpTos },
                })
                : await cloudCodeClient.resolveProjectId(accessToken, {
                    logLabel: 'AuthorizedQuota',
                    route: { isGcpTos: credential?.isGcpTos },
                });

            if (info.projectId) {
                projectId = info.projectId;
                if (credential && credential.projectId !== projectId) {
                    credential.projectId = projectId;
                    await credentialStorage.saveCredential(credential);
                }
            }
            if (Number.isFinite(info.availableAICredits)) {
                availableAICredits = Math.max(0, Number(info.availableAICredits));
                this.lastAuthorizedAvailableAICredits = availableAICredits;
            }
        } catch (error) {
            if (error instanceof CloudCodeAuthError) {
                throw error;
            }
            const err = error instanceof Error ? error : new Error(String(error));
            logger.warn(`[AuthorizedQuota] loadCodeAssist failed, continuing without project: ${err.message}`);
        }

        const models = await this.fetchAuthorizedQuotaModels(
            accessToken,
            projectId,
            activeAccount ?? undefined,
            false,
            credential?.isGcpTos,
        );
        const activeAccountAfter = await credentialStorage.getActiveAccount();
        if (this.normalizeAccount(activeAccount) !== this.normalizeAccount(activeAccountAfter)) {
            logger.info('[AuthorizedQuota] Active account changed during fetch, retrying with new account');
            this.lastAuthorizedModels = undefined;
            // 递归重试，获取新账号的配额
            return this.fetchAuthorizedTelemetry(retryCount + 1);
        }
        this.lastAuthorizedModels = models;

        const snapshot = this.buildSnapshot(
            models,
            undefined,
            undefined,
            Number.isFinite(availableAICredits)
                ? Math.max(0, Number(availableAICredits))
                : this.getCachedAuthorizedAvailableAICredits(),
        );
        const localSnapshot = await this.tryFetchLocalTelemetry();
        if (localSnapshot?.promptCredits || localSnapshot?.userInfo) {
            snapshot.promptCredits = localSnapshot.promptCredits;
            snapshot.userInfo = localSnapshot.userInfo;
        }

        return snapshot;
    }

    private normalizeAccount(value: string | null | undefined): string | null {
        if (!value) {
            return null;
        }
        const normalized = value.trim().toLowerCase();
        return normalized ? normalized : null;
    }

    private getCachedAuthorizedAvailableAICredits(): number | undefined {
        if (Number.isFinite(this.lastAuthorizedAvailableAICredits)) {
            return Math.max(0, Number(this.lastAuthorizedAvailableAICredits));
        }

        const snapshotCredits = this.lastSnapshot?.availableAICredits;
        if (Number.isFinite(snapshotCredits)) {
            return Math.max(0, Number(snapshotCredits));
        }

        return undefined;
    }

    private resolveAutoGroupFamily(modelId: string, label?: string): AutoGroupFamily | null {
        return resolveModelFamily(modelId, label);
    }

    private buildAutoFamilyGroupMap(groupMappings: Record<string, string>): Partial<Record<AutoGroupFamily, string>> {
        return buildFamilyGroupMap(groupMappings, modelId => this.resolveAutoGroupFamily(modelId));
    }

    private getNewModelsComparedToCache(
        previousCache: QuotaApiCacheRecord | null,
        latestModels: ModelQuotaInfo[],
    ): ModelQuotaInfo[] {
        if (!previousCache?.payload) {
            return [];
        }
        try {
            const previousModels = this.buildModelsFromAuthorizedResponse(
                previousCache.payload as AuthorizedQuotaResponse,
            );
            const previousIds = new Set(
                previousModels.map(model => model.modelId.trim().toLowerCase()),
            );
            const seen = new Set<string>();
            return latestModels.filter(model => {
                const normalizedId = model.modelId.trim().toLowerCase();
                if (!normalizedId || seen.has(normalizedId)) {
                    return false;
                }
                seen.add(normalizedId);
                return !previousIds.has(normalizedId);
            });
        } catch (error) {
            logger.warn(
                `[AutoGroup] Failed to compare api cache payload: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return [];
        }
    }

    private async autoAssignNewModelsToExistingGroups(
        previousCache: QuotaApiCacheRecord | null,
        latestModels: ModelQuotaInfo[],
    ): Promise<void> {
        const newModels = this.getNewModelsComparedToCache(previousCache, latestModels);
        if (newModels.length === 0) {
            return;
        }

        const config = configService.getConfig();
        const existingMappings = config.groupMappings || {};
        if (Object.keys(existingMappings).length === 0) {
            logger.info('[AutoGroup] Skip auto-assign: no existing group mappings');
            return;
        }

        const familyGroupMap = this.buildAutoFamilyGroupMap(existingMappings);
        if (Object.keys(familyGroupMap).length === 0) {
            logger.info('[AutoGroup] Skip auto-assign: no existing family groups found');
            return;
        }

        let changedCount = 0;
        const nextMappings = { ...existingMappings };
        for (const model of newModels) {
            if (!model.modelId || nextMappings[model.modelId]) {
                continue;
            }
            const family = this.resolveAutoGroupFamily(model.modelId, model.label);
            if (!family) {
                continue;
            }
            const targetGroupId = familyGroupMap[family];
            if (!targetGroupId) {
                continue;
            }
            nextMappings[model.modelId] = targetGroupId;
            changedCount++;
            logger.info(
                `[AutoGroup] Assigned new model "${model.label}" (${model.modelId}) to existing group "${targetGroupId}" (family=${family})`,
            );
        }

        if (changedCount === 0) {
            return;
        }

        await configService.updateGroupMappings(nextMappings);
        logger.info(`[AutoGroup] Auto-assigned ${changedCount} new model(s) based on api-cache diff`);
    }

    private async fetchAuthorizedQuotaModels(
        accessToken: string,
        projectId?: string,
        email?: string,
        forceRefresh: boolean = false,
        isGcpTos?: boolean,
    ): Promise<ModelQuotaInfo[]> {
        const result = await this.fetchAuthorizedQuotaModelsWithSource(
            accessToken,
            projectId,
            email,
            forceRefresh,
            isGcpTos,
        );
        return result.models;
    }

    private async fetchAuthorizedQuotaModelsWithSource(
        accessToken: string,
        projectId?: string,
        email?: string,
        forceRefresh: boolean = false,
        isGcpTos?: boolean,
    ): Promise<{ models: ModelQuotaInfo[]; fromApiCacheFile: boolean }> {
        let previousCache: QuotaApiCacheRecord | null = null;
        if (email) {
            previousCache = await readQuotaApiCache('authorized', email);
        }

        if (email && !forceRefresh && isApiCacheValid(previousCache)) {
            try {
                return {
                    models: this.buildModelsFromAuthorizedResponse(previousCache!.payload as AuthorizedQuotaResponse),
                    fromApiCacheFile: true,
                };
            } catch (error) {
                logger.warn(`[QuotaApiCache] Cached response decode failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        logger.info('[AuthorizedQuota] Fetching available models');
        const data = await cloudCodeClient.fetchAvailableModels(
            accessToken,
            projectId,
            {
                logLabel: 'AuthorizedQuota',
                route: { isGcpTos },
            },
        ) as AuthorizedQuotaResponse;

        const models = this.buildModelsFromAuthorizedResponse(data);

        if (email) {
            try {
                await this.autoAssignNewModelsToExistingGroups(previousCache, models);
            } catch (error) {
                logger.warn(`[AutoGroup] Failed to auto-assign new models: ${error instanceof Error ? error.message : String(error)}`);
            }
            try {
                await writeQuotaApiCache({
                    version: 1,
                    source: 'authorized',
                    customSource: 'plugin',
                    email,
                    projectId,
                    updatedAt: Date.now(),
                    payload: data,
                });
            } catch (error) {
                logger.warn(`[QuotaApiCache] Failed to write cache: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        return {
            models,
            fromApiCacheFile: false,
        };
    }

    private buildModelsFromAuthorizedResponse(data: AuthorizedQuotaResponse): ModelQuotaInfo[] {
        const models = mapAuthorizedResponseToModels(
            data,
            {
                unknown: t('common.unknown') || 'Unknown',
                online: t('dashboard.online') || 'Quota available',
            },
            message => logger.warn(message),
        );
        if (models.length === 0) {
            logger.warn('[AuthorizedQuota] No model found from available models response');
        }
        this.logModelList('authorized', models);
        return models;
    }

    /**
     * 检查配额重置并触发自动唤醒
     * 现在 AutoTriggerController 会自行遍历所有选中账号并获取配额
     */
    private async checkQuotaResetTrigger(): Promise<void> {
        await autoTriggerController.checkAndTriggerOnQuotaReset();
    }

    /**
     * 重新发布最近一次的遥测数据
     * 用于在配置变更等不需要重新请求 API 的场景下更新 UI
     */
    reprocess(): void {
        const quotaSource = configService.getConfig().quotaSource === 'authorized' ? 'authorized' : 'local';
        if (quotaSource === 'local' && this.lastRawResponse && this.updateHandler) {
            logger.info('Reprocessing cached local telemetry data with latest config');
            const telemetry = this.decodeSignal(this.lastRawResponse);
            this.publishTelemetry(telemetry, 'local');
            return;
        }

        if (quotaSource === 'local' && this.localUsingRemoteApi && this.lastAuthorizedModels && this.updateHandler) {
            logger.info('Reprocessing cached local(remote API) telemetry data with latest config');
            const telemetry = this.buildSnapshot(
                this.lastAuthorizedModels,
                undefined,
                undefined,
                this.getCachedAuthorizedAvailableAICredits(),
            );
            if (this.localAccountEmail) {
                telemetry.localAccountEmail = this.localAccountEmail;
            }
            this.publishTelemetry(telemetry, 'local');
            return;
        }

        if (quotaSource === 'authorized' && this.lastAuthorizedModels && this.updateHandler) {
            logger.info('Reprocessing cached authorized telemetry data with latest config');
            const telemetry = this.buildSnapshot(
                this.lastAuthorizedModels,
                undefined,
                undefined,
                this.getCachedAuthorizedAvailableAICredits(),
            );
            this.publishTelemetry(telemetry, 'authorized');
            return;
        }

        if (this.lastSnapshot && this.lastSnapshotSource === quotaSource && this.updateHandler) {
            logger.info('Reprocessing cached snapshot (no raw response)');
            this.updateHandler(this.lastSnapshot);
            return;
        }

        // 没有可用缓存，触发网络请求获取数据
        logger.warn('Cannot reprocess: no cached data available, triggering sync');
        this.syncTelemetry();
    }

    /**
     * 检查是否有缓存数据
     */
    get hasCache(): boolean {
        return !!this.lastSnapshot;
    }

    /**
     * 获取指定来源缓存的年龄（毫秒）
     */
    getCacheAgeMs(source: 'local' | 'authorized'): number | undefined {
        const lastFetchedAt = source === 'local' ? this.lastLocalFetchedAt : this.lastAuthorizedFetchedAt;
        if (!lastFetchedAt) {
            return undefined;
        }
        return Date.now() - lastFetchedAt;
    }

    /**
     * 立即发布指定来源的缓存数据（不触发网络请求）
     */
    publishCachedTelemetry(source: 'local' | 'authorized'): boolean {
        if (!this.updateHandler) {
            return false;
        }

        if (source === 'local' && this.lastRawResponse) {
            const telemetry = this.decodeSignal(this.lastRawResponse);
            this.publishTelemetry(telemetry, 'local');
            return true;
        }

        if (source === 'local' && this.localUsingRemoteApi && this.lastAuthorizedModels) {
            const telemetry = this.buildSnapshot(
                this.lastAuthorizedModels,
                undefined,
                undefined,
                this.getCachedAuthorizedAvailableAICredits(),
            );
            if (this.localAccountEmail) {
                telemetry.localAccountEmail = this.localAccountEmail;
            }
            this.publishTelemetry(telemetry, 'local');
            return true;
        }

        if (source === 'authorized' && this.lastAuthorizedModels) {
            const telemetry = this.buildSnapshot(
                this.lastAuthorizedModels,
                undefined,
                undefined,
                this.getCachedAuthorizedAvailableAICredits(),
            );
            this.publishTelemetry(telemetry, 'authorized');
            return true;
        }

        if (this.lastSnapshot && this.lastSnapshotSource === source) {
            this.updateHandler(this.lastSnapshot);
            return true;
        }

        return false;
    }

    /**
     * 解码服务端响应
     */
    private decodeSignal(data: ServerUserStatusResponse): QuotaSnapshot {
        // 验证响应数据结构
        if (!data || !data.userStatus) {
            // 如果服务端返回了错误消息，直接透传给用户，这不属于插件 Bug
            if (data && typeof data.message === 'string') {
                throw new AntigravityError(t('error.serverError', { message: data.message }));
            }

            throw new Error(t('error.invalidResponse', { 
                details: data ? JSON.stringify(data).substring(0, 100) : 'empty response', 
            }));
        }
        
        const status = data.userStatus;
        const plan = status.planStatus?.planInfo;
        const credits = status.planStatus?.availablePromptCredits;

        let promptCredits: PromptCreditsInfo | undefined;

        if (plan && credits !== undefined) {
            const monthlyLimit = Number(plan.monthlyPromptCredits);
            const availableVal = Number(credits);

            if (monthlyLimit > 0) {
                promptCredits = {
                    available: availableVal,
                    monthly: monthlyLimit,
                    usedPercentage: ((monthlyLimit - availableVal) / monthlyLimit) * 100,
                    remainingPercentage: (availableVal / monthlyLimit) * 100,
                };
            }
        }

        const userInfo: UserInfo = {
            name: status.name || 'Unknown User',
            email: status.email || 'N/A',
            planName: plan?.planName || 'N/A',
            tier: status.userTier?.name || plan?.teamsTier || 'N/A',
            browserEnabled: plan?.browserEnabled === true,
            knowledgeBaseEnabled: plan?.knowledgeBaseEnabled === true,
            canBuyMoreCredits: plan?.canBuyMoreCredits === true,
            hasAutocompleteFastMode: plan?.hasAutocompleteFastMode === true,
            monthlyPromptCredits: plan?.monthlyPromptCredits || 0,
            monthlyFlowCredits: plan?.monthlyFlowCredits || 0,
            availablePromptCredits: status.planStatus?.availablePromptCredits || 0,
            availableFlowCredits: status.planStatus?.availableFlowCredits || 0,
            cascadeWebSearchEnabled: plan?.cascadeWebSearchEnabled === true,
            canGenerateCommitMessages: plan?.canGenerateCommitMessages === true,
            allowMcpServers: plan?.defaultTeamConfig?.allowMcpServers === true,
            maxNumChatInputTokens: String(plan?.maxNumChatInputTokens ?? 'N/A'),
            tierDescription: status.userTier?.description || 'N/A',
            upgradeUri: status.userTier?.upgradeSubscriptionUri || '',
            upgradeText: status.userTier?.upgradeSubscriptionText || '',
            
            // New fields population
            teamsTier: plan?.teamsTier || 'N/A',
            hasTabToJump: plan?.hasTabToJump === true,
            allowStickyPremiumModels: plan?.allowStickyPremiumModels === true,
            allowPremiumCommandModels: plan?.allowPremiumCommandModels === true,
            maxNumPremiumChatMessages: String(plan?.maxNumPremiumChatMessages ?? 'N/A'),
            maxCustomChatInstructionCharacters: String(plan?.maxCustomChatInstructionCharacters ?? 'N/A'),
            maxNumPinnedContextItems: String(plan?.maxNumPinnedContextItems ?? 'N/A'),
            maxLocalIndexSize: String(plan?.maxLocalIndexSize ?? 'N/A'),
            monthlyFlexCreditPurchaseAmount: Number(plan?.monthlyFlexCreditPurchaseAmount) || 0,
            canCustomizeAppIcon: plan?.canCustomizeAppIcon === true,
            cascadeCanAutoRunCommands: plan?.cascadeCanAutoRunCommands === true,
            canAllowCascadeInBackground: plan?.canAllowCascadeInBackground === true,
            allowAutoRunCommands: plan?.defaultTeamConfig?.allowAutoRunCommands === true,
            allowBrowserExperimentalFeatures: plan?.defaultTeamConfig?.allowBrowserExperimentalFeatures === true,
            acceptedLatestTermsOfService: status.acceptedLatestTermsOfService === true,
            userTierId: status.userTier?.id || 'N/A',
        };

        const configs: ClientModelConfig[] = status.cascadeModelConfigData?.clientModelConfigs || [];
        const modelSorts = status.cascadeModelConfigData?.clientModelSorts || [];

        const models = mapLocalConfigsToModels(
            configs,
            modelSorts,
            {
                unknown: t('common.unknown') || 'Unknown',
                online: t('dashboard.online') || 'Quota available',
            },
            message => logger.warn(message),
        );

        this.logModelList('local', models);
        return this.buildSnapshot(models, promptCredits, userInfo);
    }

    private logModelList(source: 'local' | 'authorized', models: ModelQuotaInfo[]): void {
        if (models.length === 0) {
            return;
        }

        const items = models.map(model => ({
            modelId: model.modelId,
            label: model.label,
            isRecommended: model.isRecommended,
            tagTitle: model.tagTitle,
        }));
        const payload = JSON.stringify(items);
        const lastPayload = source === 'local'
            ? this.lastLoggedLocalModelList
            : this.lastLoggedAuthorizedModelList;
        if (payload === lastPayload) {
            return;
        }
        if (source === 'local') {
            this.lastLoggedLocalModelList = payload;
        } else {
            this.lastLoggedAuthorizedModelList = payload;
        }
        logger.info(`[ModelList:${source}] count=${items.length} items=${payload}`);
    }

    private buildSnapshot(
        models: ModelQuotaInfo[],
        promptCredits?: PromptCreditsInfo,
        userInfo?: UserInfo,
        availableAICredits?: number,
    ): QuotaSnapshot {
        const config = configService.getConfig();
        const allModels = [...models];

        // 官方上线新模型时（如 Gemini-4），自动将其纳入用户已自定义的可见列表
        const adoptedVisibleModels = this.adoptNewlyDiscoveredModels(allModels);

        const assembly = assembleSnapshotModels(allModels, {
            groupingEnabled: config.groupingEnabled,
            groupMappings: config.groupMappings,
            groupingCustomNames: config.groupingCustomNames,
            visibleModels: adoptedVisibleModels ?? config.visibleModels ?? [],
        });

        if (assembly.resetVisibleModels) {
            logger.warn('[buildSnapshot] Visible models filter resulted in empty list. '
                + `Original: ${allModels.length}, resetting visible list to show all models.`);
            void configService.updateVisibleModels([]);
        }

        if (assembly.removedMappingIds.length > 0) {
            const newMappings = { ...config.groupMappings };
            for (const modelId of assembly.removedMappingIds) {
                delete newMappings[modelId];
                logger.info(`[GroupCheck] Removing model "${modelId}" from its group due to quota mismatch`);
            }
            configService.updateGroupMappings(newMappings).catch((err: unknown) => {
                logger.warn(`Failed to save updated groupMappings: ${String(err)}`);
            });
            logger.info(`[GroupCheck] Removed ${assembly.removedMappingIds.length} models from groups due to quota mismatch`);
        }

        if (config.groupingEnabled) {
            logger.debug(`Grouping enabled: ${assembly.groups?.length ?? 0} groups created`);
        }

        // 将配额中的模型常量传递给 AutoTriggerController，用于过滤可触发模型
        autoTriggerController.setQuotaModels(assembly.models.map(m => m.modelId));

        return {
            timestamp: new Date(),
            availableAICredits,
            promptCredits,
            userInfo,
            models: assembly.models,
            allModels,
            groups: assembly.groups,
            isConnected: true,
        };
    }

    public buildAuthorizedSnapshotFromResponse(data: unknown, updatedAt?: number): QuotaSnapshot {
        const models = this.buildModelsFromAuthorizedResponse(data as AuthorizedQuotaResponse);
        const snapshot = this.buildSnapshot(
            models,
            undefined,
            undefined,
            this.getCachedAuthorizedAvailableAICredits(),
        );
        if (updatedAt) {
            snapshot.timestamp = new Date(updatedAt);
        }
        return snapshot;
    }

    /**
     * 识别官方新上线模型并自动纳入可见列表（API 模型清单更新无需等插件发版）。
     * @returns 合并后的可见模型 ID 列表；无需变更时返回 null
     */
    private adoptNewlyDiscoveredModels(allModels: ModelQuotaInfo[]): string[] | null {
        const currentIds = allModels.map(model => model.modelId);
        const stored = configService.getStateValue<string[]>(KNOWN_MODEL_IDS_STATE_KEY);
        const result = computeModelAdoption({
            currentIds,
            storedIds: Array.isArray(stored) ? stored : undefined,
            visibleIds: configService.getConfig().visibleModels ?? [],
            blacklist: AUTH_MODEL_BLACKLIST_ID_SET,
        });

        if (stored === undefined || result.newIds.length > 0) {
            void configService.setStateValue(KNOWN_MODEL_IDS_STATE_KEY, result.nextKnownIds);
        }
        if (result.newIds.length === 0) {
            return null;
        }

        logger.info(`[ModelAdoption] Detected ${result.newIds.length} new model(s) from API: ${result.newIds.join(', ')}`);
        if (!result.mergedVisibleIds) {
            return null;
        }

        void configService.updateVisibleModels(result.mergedVisibleIds);
        logger.info(`[ModelAdoption] Auto-visible new model(s): ${result.newIds.join(', ')}`);
        return result.mergedVisibleIds;
    }


    /**
     * 创建离线状态的快照
     */
    static createOfflineSnapshot(errorMessage?: string): QuotaSnapshot {
        return {
            timestamp: new Date(),
            models: [],
            isConnected: false,
            errorMessage,
        };
    }

    /**
     * 计算“自动分组”同款分组结果（家族匹配 + 固定组名）
     */
    static calculateSmartGrouping(models: ModelQuotaInfo[]): {
        groupMappings: Record<string, string>;
        groupNames: Record<string, string>;
    } {
        return calculateSmartGrouping(models);
    }

    /**
     * 根据当前模型列表计算分组映射（与“自动分组”一致）
     * 返回 modelId -> groupId 的映射
     */
    static calculateGroupMappings(models: ModelQuotaInfo[]): Record<string, string> {
        return calculateSmartGrouping(models).groupMappings;
    }
}

// 保持向后兼容
export type quota_snapshot = QuotaSnapshot;
export type model_quota_info = ModelQuotaInfo;
