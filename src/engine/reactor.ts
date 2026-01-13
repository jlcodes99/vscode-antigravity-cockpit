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
    QuotaGroup,
    ScanDiagnostics,
    UserInfo,
} from '../shared/types';
import { logger } from '../shared/log_service';
import { configService } from '../shared/config_service';
import { t } from '../shared/i18n';
import { TIMING, API_ENDPOINTS } from '../shared/constants';
import { captureError } from '../shared/error_reporter';
import { AntigravityError, isServerError } from '../shared/errors';
import { cloudCodeClient, CloudCodeAuthError, CloudCodeRequestError } from '../shared/cloudcode_client';
import { autoTriggerController } from '../auto_trigger/controller';
import { oauthService, credentialStorage, ensureLocalCredentialImported } from '../auto_trigger';
import { antigravityToolsSyncService } from '../antigravityTools_sync';

const AUTH_RECOMMENDED_LABELS = [
    'Claude Opus 4.5 (Thinking)',
    'Claude Sonnet 4.5',
    'Claude Sonnet 4.5 (Thinking)',
    'Gemini 3 Flash',
    'Gemini 3 Pro (High)',
    'Gemini 3 Pro (Low)',
    'Gemini 3 Pro Image',
    'GPT-OSS 120B (Medium)',
];

const AUTH_RECOMMENDED_MODEL_IDS = [
    'MODEL_PLACEHOLDER_M12', // Claude Opus 4.5 (Thinking)
    'MODEL_CLAUDE_4_5_SONNET',
    'MODEL_CLAUDE_4_5_SONNET_THINKING',
    'MODEL_PLACEHOLDER_M18', // Gemini 3 Flash
    'MODEL_PLACEHOLDER_M7', // Gemini 3 Pro (High)
    'MODEL_PLACEHOLDER_M8', // Gemini 3 Pro (Low)
    'MODEL_PLACEHOLDER_M9', // Gemini 3 Pro Image
    'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
];

const AUTH_RECOMMENDED_LABEL_RANK = new Map(
    AUTH_RECOMMENDED_LABELS.map((label, index) => [label, index]),
);

const AUTH_RECOMMENDED_ID_RANK = new Map(
    AUTH_RECOMMENDED_MODEL_IDS.map((id, index) => [id, index]),
);

const normalizeRecommendedKey = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9]/g, '');

const AUTH_RECOMMENDED_LABEL_KEY_RANK = new Map(
    AUTH_RECOMMENDED_LABELS.map((label, index) => [normalizeRecommendedKey(label), index]),
);

const AUTH_RECOMMENDED_ID_KEY_RANK = new Map(
    AUTH_RECOMMENDED_MODEL_IDS.map((id, index) => [normalizeRecommendedKey(id), index]),
);


interface AuthorizedQuotaInfo {
    remainingFraction?: number;
    resetTime?: string;
}

interface AuthorizedModelInfo {
    displayName?: string;
    model?: string;
    quotaInfo?: AuthorizedQuotaInfo;
    // 模型能力字段
    supportsImages?: boolean;
    supportsVideo?: boolean;
    supportsThinking?: boolean;
    thinkingBudget?: number;
    minThinkingBudget?: number;
    maxTokens?: number;
    maxOutputTokens?: number;
    recommended?: boolean;
    tagTitle?: string;
    supportedMimeTypes?: Record<string, boolean>;
    isInternal?: boolean;
}

interface AuthorizedQuotaResponse {
    models?: Record<string, AuthorizedModelInfo>;
}


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
    /** 本地配额上次拉取时间 */
    private lastLocalFetchedAt?: number;
    /** 授权配额上次拉取时间 */
    private lastAuthorizedFetchedAt?: number;
    /** 是否已经成功获取过配额数据（用于决定是否上报后续错误） */
    private hasSuccessfulSync: boolean = false;
    /** 初始化同步重试标识，用于中断本地重试流程 */
    private initRetryToken: number = 0;
    /** 本地模式下的账户邮箱（从 state.vscdb 读取） */
    private localAccountEmail?: string;
    /** 本地模式是否使用远端 API */
    private localUsingRemoteApi: boolean = false;

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
            
            // 服务端返回的错误不上报（如"未登录"），这不属于插件 Bug
            if (!isServerError(err)) {
                captureError(err, {
                    phase: 'initSync',
                    retryCount: currentRetry,
                    maxRetries,
                    endpoint: API_ENDPOINTS.GET_USER_STATUS,
                    host: '127.0.0.1',
                    port: this.port,
                    timeout_ms: TIMING.HTTP_TIMEOUT_MS,
                    interval_ms: this.currentInterval,
                    has_token: Boolean(this.token),
                    scan: this.lastScanDiagnostics,
                });
            }
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
            
            // 只有在从未成功获取过配额时才上报，成功后的定时同步失败不上报
            // 服务端返回的错误不上报（如"未登录"），这不属于插件 Bug
            if (!this.hasSuccessfulSync && !isServerError(err)) {
                captureError(err, {
                    phase: 'telemetrySync',
                    endpoint: API_ENDPOINTS.GET_USER_STATUS,
                    host: '127.0.0.1',
                    port: this.port,
                    timeout_ms: TIMING.HTTP_TIMEOUT_MS,
                    interval_ms: this.currentInterval,
                    has_token: Boolean(this.token),
                    scan: this.lastScanDiagnostics,
                });
            }
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
            const autoSwitchEnabled = configService.getStateFlag('antigravityToolsAutoSwitchEnabled', true);
            if (autoSwitchEnabled) {
                const toolsMatchedEmail = await this.resolveToolsAuthorizedEmail();
                if (toolsMatchedEmail) {
                    await this.ensureActiveAccount(toolsMatchedEmail);
                } else {
                    const localSnapshot = await this.tryFetchLocalTelemetry();
                    const localEmail = localSnapshot?.userInfo?.email;
                    const localEmailValid = Boolean(
                        localEmail && localEmail.trim() && localEmail !== 'N/A' && localEmail.includes('@'),
                    );
                    if (localEmail && localEmailValid) {
                        const localMatchedEmail = await this.resolveAuthorizedEmail(localEmail);
                        if (localMatchedEmail) {
                            await this.ensureActiveAccount(localMatchedEmail);
                        }
                    }
                }
            }

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
                        const telemetry = this.buildSnapshot(this.lastAuthorizedModels);
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

        // Local 模式：优先尝试 state.vscdb 账户 + 远端 API，失败则兜底本地进程
        try {
            const telemetry = await this.fetchLocalTelemetryWithRemoteFallback();
            this.publishTelemetry(telemetry, 'local');
        } catch (error) {
            throw this.wrapSyncError(error, 'local');
        }
    }

    /**
     * 获取本地配额数据，优先使用远端 API（自动导入 state.vscdb 账户）
     * 如果远端 API 失败，兜底到本地进程 API
     */
    private async fetchLocalTelemetryWithRemoteFallback(): Promise<QuotaSnapshot> {
        // 第一优先级：确保本地账户已导入，然后使用远端 API
        try {
            const importResult = await ensureLocalCredentialImported();
            if (importResult) {
                logger.info(`[LocalQuota] Using remote API with account: ${importResult.email}`);
                
                // 复用授权模式的逻辑获取配额
                const telemetry = await this.fetchAuthorizedTelemetry();
                
                this.localAccountEmail = importResult.email;
                this.localUsingRemoteApi = true;
                this.lastLocalFetchedAt = Date.now();
                
                // 添加本地账户信息到快照
                telemetry.localAccountEmail = importResult.email;
                return telemetry;
            }
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.warn(`[LocalQuota] Remote API failed, falling back to local process: ${err.message}`);
        }

        // 第二优先级：兜底到本地进程 API
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

        // 标记已成功获取过配额数据，后续定时同步失败不再上报
        this.hasSuccessfulSync = true;

        if (this.updateHandler) {
            this.updateHandler(telemetry);
        }
        
        // 检查配额重置并触发自动唤醒（异步执行，不阻塞主流程）
        if (telemetry.models.length > 0) {
            this.checkQuotaResetTrigger(telemetry.models).catch(err => {
                logger.warn(`[ReactorCore] Wake on reset check failed: ${err}`);
            });
        }
    }

    /**
     * 获取授权配额并构建快照
     */
    private async fetchAuthorizedTelemetry(): Promise<QuotaSnapshot> {
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
        const credential = await credentialStorage.getCredential();
        if (credential?.projectId) {
            projectId = credential.projectId;
        } else {
            try {
                const info = await cloudCodeClient.resolveProjectId(accessToken, { logLabel: 'AuthorizedQuota' });
                if (info.projectId) {
                    projectId = info.projectId;
                    if (credential) {
                        credential.projectId = projectId;
                        await credentialStorage.saveCredential(credential);
                    }
                }
            } catch (error) {
                if (error instanceof CloudCodeAuthError) {
                    throw error;
                }
                const err = error instanceof Error ? error : new Error(String(error));
                logger.warn(`[AuthorizedQuota] loadCodeAssist failed, continuing without project: ${err.message}`);
            }
        }

        const models = await this.fetchAuthorizedQuotaModels(accessToken, projectId);
        const activeAccountAfter = await credentialStorage.getActiveAccount();
        if (this.normalizeAccount(activeAccount) !== this.normalizeAccount(activeAccountAfter)) {
            logger.info('[AuthorizedQuota] Active account changed during fetch, dropping stale result');
            this.lastAuthorizedModels = undefined;
            return ReactorCore.createOfflineSnapshot();
        }
        this.lastAuthorizedModels = models;
        await this.ensureAuthorizedVisibleModels(models);
        return this.buildSnapshot(models);
    }

    private normalizeAccount(value: string | null | undefined): string | null {
        if (!value) {
            return null;
        }
        const normalized = value.trim().toLowerCase();
        return normalized ? normalized : null;
    }

    private async fetchAuthorizedQuotaModels(accessToken: string, projectId?: string): Promise<ModelQuotaInfo[]> {
        logger.info('[AuthorizedQuota] Fetching available models');
        const data = await cloudCodeClient.fetchAvailableModels(
            accessToken,
            projectId,
            { logLabel: 'AuthorizedQuota' },
        ) as AuthorizedQuotaResponse;
        const models: ModelQuotaInfo[] = [];
        const now = Date.now();

        if (!data.models) {
            return models;
        }

        for (const [modelKey, info] of Object.entries(data.models)) {
            const quotaInfo = info.quotaInfo;
            if (!quotaInfo) {
                continue;
            }

            const remainingFraction = Math.min(1, Math.max(0, quotaInfo.remainingFraction ?? 0));
            
            // 解析 resetTime，处理无效值的情况
            let resetTime: Date;
            let resetTimeValid = true;
            if (quotaInfo.resetTime) {
                const parsed = new Date(quotaInfo.resetTime);
                if (!Number.isNaN(parsed.getTime())) {
                    resetTime = parsed;
                } else {
                    // 无效的 resetTime 字符串，使用 24 小时后作为备用
                    resetTime = new Date(now + 24 * 60 * 60 * 1000);
                    resetTimeValid = false;
                    logger.warn(`[AuthorizedQuota] Invalid resetTime for model ${modelKey}: ${quotaInfo.resetTime}`);
                }
            } else {
                // 没有 resetTime，使用 24 小时后作为备用
                resetTime = new Date(now + 24 * 60 * 60 * 1000);
                resetTimeValid = false;
            }
            
            const timeUntilReset = Math.max(0, resetTime.getTime() - now);
            const modelId = info.model || modelKey;
            const label = info.displayName || modelKey;

            models.push({
                label,
                modelId,
                remainingFraction,
                remainingPercentage: remainingFraction * 100,
                isExhausted: remainingFraction <= 0,
                resetTime,
                resetTimeDisplay: resetTimeValid ? this.formatIso(resetTime) : (t('common.unknown') || 'Unknown'),
                timeUntilReset,
                timeUntilResetFormatted: resetTimeValid ? this.formatDelta(timeUntilReset) : (t('common.unknown') || 'Unknown'),
                resetTimeValid,
                // 模型能力字段
                supportsImages: info.supportsImages,
                isRecommended: info.recommended,
                tagTitle: info.tagTitle,
                supportedMimeTypes: info.supportedMimeTypes,
            });
        }

        models.sort((a, b) => a.label.localeCompare(b.label));
        return models;
    }
    
    /**
     * 检查配额重置并触发自动唤醒
     */
    private async checkQuotaResetTrigger(models: ModelQuotaInfo[]): Promise<void> {
        // 构建检测所需的数据
        const modelData = models
            .filter(m => {
                if (m.resetTimeValid === false) {
                    logger.debug(`[ReactorCore] Skip wake on reset: invalid resetTime for ${m.label}`);
                    return false;
                }
                const resetAtMs = m.resetTime.getTime();
                if (Number.isNaN(resetAtMs)) {
                    logger.warn(`[ReactorCore] Skip wake on reset: NaN resetTime for ${m.label}`);
                    return false;
                }
                return true;
            })
            .map(m => ({
                id: m.modelId,
                resetAt: m.resetTime.toISOString(),
                remaining: m.remainingFraction !== undefined ? Math.floor(m.remainingFraction * 100) : 0,
                limit: 100,  // 使用百分比，limit 固定为 100
            }));

        if (modelData.length === 0) {
            logger.debug('[ReactorCore] Wake on reset: no valid models to check');
            return;
        }

        await autoTriggerController.checkAndTriggerOnQuotaReset(modelData);
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

        if (quotaSource === 'authorized' && this.lastAuthorizedModels && this.updateHandler) {
            logger.info('Reprocessing cached authorized telemetry data with latest config');
            const telemetry = this.buildSnapshot(this.lastAuthorizedModels);
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

        if (source === 'authorized' && this.lastAuthorizedModels) {
            const telemetry = this.buildSnapshot(this.lastAuthorizedModels);
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

        // 构建排序顺序映射（从 clientModelSorts 获取）
        const sortOrderMap = new Map<string, number>();
        if (modelSorts.length > 0) {
            // 使用第一个排序配置（通常是 "Recommended"）
            const primarySort = modelSorts[0];
            let index = 0;
            for (const group of primarySort.groups) {
                for (const label of group.modelLabels) {
                    sortOrderMap.set(label, index++);
                }
            }
        }

        const models: ModelQuotaInfo[] = configs
            .filter((m): m is ClientModelConfig & { quotaInfo: NonNullable<ClientModelConfig['quotaInfo']> } => 
                !!m.quotaInfo,
            )
            .map((m) => {
                const now = new Date();
                let reset = new Date(m.quotaInfo.resetTime);
                let resetTimeValid = true;
                if (Number.isNaN(reset.getTime())) {
                    reset = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                    resetTimeValid = false;
                    logger.warn(`[ReactorCore] Invalid resetTime for model ${m.label}: ${m.quotaInfo.resetTime}`);
                }
                const delta = reset.getTime() - now.getTime();

                return {
                    label: m.label,
                    modelId: m.modelOrAlias?.model || 'unknown',
                    remainingFraction: m.quotaInfo.remainingFraction,
                    remainingPercentage: m.quotaInfo.remainingFraction !== undefined 
                        ? m.quotaInfo.remainingFraction * 100 
                        : undefined,
                    isExhausted: m.quotaInfo.remainingFraction === 0,
                    resetTime: reset,
                    resetTimeDisplay: resetTimeValid ? this.formatIso(reset) : (t('common.unknown') || 'Unknown'),
                    timeUntilReset: delta,
                    timeUntilResetFormatted: resetTimeValid ? this.formatDelta(delta) : (t('common.unknown') || 'Unknown'),
                    resetTimeValid,
                    // 模型能力字段
                    supportsImages: m.supportsImages,
                    isRecommended: m.isRecommended,
                    tagTitle: m.tagTitle,
                    supportedMimeTypes: m.supportedMimeTypes,
                };
            });

        // 排序：优先使用 clientModelSorts，否则按 label 字母排序
        models.sort((a, b) => {
            const indexA = sortOrderMap.get(a.label);
            const indexB = sortOrderMap.get(b.label);

            // 两个都在排序列表中，按排序列表顺序
            if (indexA !== undefined && indexB !== undefined) {
                return indexA - indexB;
            }
            // 只有 a 在排序列表中，a 排前面
            if (indexA !== undefined) {
                return -1;
            }
            // 只有 b 在排序列表中，b 排前面
            if (indexB !== undefined) {
                return 1;
            }
            // 都不在排序列表中，按 label 字母排序
            return a.label.localeCompare(b.label);
        });

        return this.buildSnapshot(models, promptCredits, userInfo);
    }

    private buildSnapshot(
        models: ModelQuotaInfo[],
        promptCredits?: PromptCreditsInfo,
        userInfo?: UserInfo,
    ): QuotaSnapshot {
        const config = configService.getConfig();
        const allModels = [...models];
        const visibleModels = config.visibleModels ?? [];
        if (visibleModels.length > 0) {
            const visibleSet = new Set(visibleModels);
            const filteredModels = models.filter(model => visibleSet.has(model.modelId));
            
            // 安全检查：如果过滤后为空但原始列表不为空，可能是配置问题
            if (filteredModels.length === 0 && models.length > 0) {
                logger.warn(`[buildSnapshot] Visible models filter resulted in empty list. ` +
                    `Original: ${models.length}, Visible config: ${visibleModels.length}. ` +
                    `Showing all models instead.`);
                // 不应用过滤，保留原始列表
            } else {
                models = filteredModels;
            }
        }

        // 分组逻辑：使用存储的 groupMappings 进行分组
        let groups: QuotaGroup[] | undefined;
        
        if (config.groupingEnabled) {
            const groupMap = new Map<string, ModelQuotaInfo[]>();
            const savedMappings = config.groupMappings;
            const hasSavedMappings = Object.keys(savedMappings).length > 0;
            
            if (hasSavedMappings) {
                // 使用存储的分组映射
                for (const model of models) {
                    const groupId = savedMappings[model.modelId];
                    if (groupId) {
                        if (!groupMap.has(groupId)) {
                            groupMap.set(groupId, []);
                        }
                        groupMap.get(groupId)!.push(model);
                    } else {
                        // 新模型，单独一组（使用自己的 modelId 作为 groupId）
                        groupMap.set(model.modelId, [model]);
                    }
                }
                
                // 自动分组检查：检查每个分组内模型的配额是否一致
                // 如果不一致，只将不一致的模型移出分组（保留用户自定义设置）
                const modelsToRemove: string[] = [];
                
                for (const [groupId, groupModels] of groupMap) {
                    if (groupModels.length <= 1) {
                        continue; // 单模型组无需检查
                    }
                    
                    // 检查组内所有模型的配额签名（remainingFraction + resetTime）是否一致
                    // 使用多数派原则：找出最常见的配额签名，将不符合的模型移除
                    const signatureCount = new Map<string, { count: number; fraction: number; resetTime: number }>();
                    
                    for (const model of groupModels) {
                        const fraction = model.remainingFraction ?? 0;
                        const resetTime = model.resetTime.getTime();
                        const signature = `${fraction.toFixed(6)}_${resetTime}`;
                        
                        if (!signatureCount.has(signature)) {
                            signatureCount.set(signature, { count: 0, fraction, resetTime });
                        }
                        signatureCount.get(signature)!.count++;
                    }
                    
                    // 找出最常见的签名（多数派）
                    let majoritySignature = '';
                    let maxCount = 0;
                    for (const [sig, data] of signatureCount) {
                        if (data.count > maxCount) {
                            maxCount = data.count;
                            majoritySignature = sig;
                        }
                    }
                    
                    // 标记不符合多数派的模型移出分组
                    for (const model of groupModels) {
                        const fraction = model.remainingFraction ?? 0;
                        const resetTime = model.resetTime.getTime();
                        const signature = `${fraction.toFixed(6)}_${resetTime}`;
                        
                        if (signature !== majoritySignature) {
                            logger.info(`[GroupCheck] Removing model "${model.label}" from group "${groupId}" due to quota mismatch`);
                            modelsToRemove.push(model.modelId);
                        }
                    }
                }
                
                // 更新 groupMappings，移除不一致的模型
                if (modelsToRemove.length > 0) {
                    const newMappings = { ...savedMappings };
                    for (const modelId of modelsToRemove) {
                        delete newMappings[modelId];
                    }
                    
                    configService.updateGroupMappings(newMappings).catch(err => {
                        logger.warn(`Failed to save updated groupMappings: ${err}`);
                    });
                    
                    // 从 groupMap 中移除这些模型，并为它们创建独立分组
                    for (const modelId of modelsToRemove) {
                        // 从原分组中移除
                        for (const [gid, gModels] of groupMap) {
                            const idx = gModels.findIndex(m => m.modelId === modelId);
                            if (idx !== -1) {
                                const [removedModel] = gModels.splice(idx, 1);
                                // 创建独立分组
                                groupMap.set(modelId, [removedModel]);
                                break;
                            }
                        }
                    }
                    
                    // 清理空的分组
                    for (const [gid, gModels] of groupMap) {
                        if (gModels.length === 0) {
                            groupMap.delete(gid);
                        }
                    }
                    
                    logger.info(`[GroupCheck] Removed ${modelsToRemove.length} models from groups due to quota mismatch`);
                }
            } else {
                // 没有存储的映射，每个模型单独一组
                for (const model of models) {
                    groupMap.set(model.modelId, [model]);
                }
            }
            
            // 转换为 QuotaGroup 数组
            groups = [];
            let groupIndex = 1;
            
            for (const [groupId, groupModels] of groupMap) {
                // 锚点共识：查找组内模型的自定义名称
                let groupName = '';
                const customNames = config.groupingCustomNames;
                
                // 统计每个自定义名称的投票数
                const nameVotes = new Map<string, number>();
                for (const model of groupModels) {
                    const customName = customNames[model.modelId];
                    if (customName) {
                        nameVotes.set(customName, (nameVotes.get(customName) || 0) + 1);
                    }
                }
                
                // 选择投票数最多的名称
                if (nameVotes.size > 0) {
                    let maxVotes = 0;
                    for (const [name, votes] of nameVotes) {
                        if (votes > maxVotes) {
                            maxVotes = votes;
                            groupName = name;
                        }
                    }
                }
                
                // 如果没有自定义名称，使用默认名称
                if (!groupName) {
                    if (groupModels.length === 1) {
                        groupName = groupModels[0].label;
                    } else {
                        groupName = `Group ${groupIndex}`;
                    }
                }
                
                const firstModel = groupModels[0];
                // 计算组内所有模型的平均/最低配额
                const minPercentage = Math.min(...groupModels.map(m => m.remainingPercentage ?? 0));
                
                groups.push({
                    groupId,
                    groupName,
                    models: groupModels,
                    remainingPercentage: minPercentage,
                    resetTime: firstModel.resetTime,
                    resetTimeDisplay: firstModel.resetTimeDisplay,
                    timeUntilResetFormatted: firstModel.timeUntilResetFormatted,
                    isExhausted: groupModels.some(m => m.isExhausted),
                });
                
                groupIndex++;
            }
            
            // 按组内模型在原始列表中的最小索引排序，保持相对顺序
            const modelIndexMap = new Map<string, number>();
            models.forEach((m, i) => modelIndexMap.set(m.modelId, i));

            groups.sort((a, b) => {
                // 获取 A 组中最靠前的模型索引
                const minIndexA = Math.min(...a.models.map(m => modelIndexMap.get(m.modelId) ?? 99999));
                // 获取 B 组中最靠前的模型索引
                const minIndexB = Math.min(...b.models.map(m => modelIndexMap.get(m.modelId) ?? 99999));
                return minIndexA - minIndexB;
            });
            
            logger.debug(`Grouping enabled: ${groups.length} groups created (saved mappings: ${hasSavedMappings})`);
        }

        // 将配额中的模型常量传递给 AutoTriggerController，用于过滤可触发模型
        const quotaModelConstants = models.map(m => m.modelId);
        autoTriggerController.setQuotaModels(quotaModelConstants);

        return {
            timestamp: new Date(),
            promptCredits,
            userInfo,
            models,
            allModels,
            groups,
            isConnected: true,
        };
    }

    private getAuthorizedRecommendedIds(models: ModelQuotaInfo[]): string[] {
        return models
            .filter(model => this.getAuthorizedRecommendedRank(model) < Number.MAX_SAFE_INTEGER)
            .sort((a, b) => {
                const aRank = this.getAuthorizedRecommendedRank(a);
                const bRank = this.getAuthorizedRecommendedRank(b);
                if (aRank !== bRank) {
                    return aRank - bRank;
                }
                return a.label.localeCompare(b.label);
            })
            .map(model => model.modelId);
    }

    private getAuthorizedRecommendedRank(model: ModelQuotaInfo): number {
        const idRank = AUTH_RECOMMENDED_ID_RANK.get(model.modelId);
        if (idRank !== undefined) {
            return idRank;
        }
        const labelRank = AUTH_RECOMMENDED_LABEL_RANK.get(model.label);
        if (labelRank !== undefined) {
            return labelRank;
        }
        const normalizedId = normalizeRecommendedKey(model.modelId);
        const normalizedLabel = normalizeRecommendedKey(model.label);
        return Math.min(
            AUTH_RECOMMENDED_ID_KEY_RANK.get(normalizedId) ?? Number.MAX_SAFE_INTEGER,
            AUTH_RECOMMENDED_LABEL_KEY_RANK.get(normalizedLabel) ?? Number.MAX_SAFE_INTEGER,
        );
    }

    private async ensureAuthorizedVisibleModels(models: ModelQuotaInfo[]): Promise<void> {
        const config = configService.getConfig();
        if (config.quotaSource !== 'authorized') {
            return;
        }

        const initialized = configService.getStateFlag('visibleModelsInitializedAuthorized', false);
        if (config.visibleModels.length > 0) {
            if (!initialized) {
                await configService.setStateFlag('visibleModelsInitializedAuthorized', true);
            }
            return;
        }

        if (initialized || models.length === 0) {
            return;
        }

        const recommendedIds = this.getAuthorizedRecommendedIds(models);
        const defaultVisible = recommendedIds.length > 0
            ? recommendedIds
            : models.map(model => model.modelId);
        await configService.updateVisibleModels(defaultVisible);
        await configService.setStateFlag('visibleModelsInitializedAuthorized', true);
    }

    /**
     * 格式化日期（自动国际化）
     */
    private formatIso(d: Date): string {
        const dateStr = d.toLocaleDateString(undefined, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        const timeStr = d.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
        return `${dateStr} ${timeStr}`;
    }

    /**
     * 格式化时间差
     * - < 60分钟: 显示 Xm
     * - < 24小时: 显示 Xh Ym
     * - >= 24小时: 显示 Xd Yh Zm
     */
    private formatDelta(ms: number): string {
        if (ms <= 0) {
            return t('dashboard.online');
        }
        const totalMinutes = Math.ceil(ms / 60000);
        
        // 小于 60 分钟：只显示分钟
        if (totalMinutes < 60) {
            return `${totalMinutes}m`;
        }
        
        const totalHours = Math.floor(totalMinutes / 60);
        const remainingMinutes = totalMinutes % 60;
        
        // 小于 24 小时：显示小时和分钟
        if (totalHours < 24) {
            return `${totalHours}h ${remainingMinutes}m`;
        }
        
        // >= 24 小时：显示天、小时、分钟
        const days = Math.floor(totalHours / 24);
        const remainingHours = totalHours % 24;
        return `${days}d ${remainingHours}h ${remainingMinutes}m`;
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
     * 根据当前配额信息计算分组映射
     * 返回 modelId -> groupId 的映射
     */
    static calculateGroupMappings(models: ModelQuotaInfo[]): Record<string, string> {
        // 1. 尝试按配额状态分组（旧逻辑）
        const statsMap = new Map<string, string[]>();
        for (const model of models) {
            const fingerprint = `${model.remainingFraction?.toFixed(6)}_${model.resetTime.getTime()}`;
            if (!statsMap.has(fingerprint)) {
                statsMap.set(fingerprint, []);
            }
            statsMap.get(fingerprint)!.push(model.modelId);
        }

        // 2. 检查是否所有模型都被分到了同一个大组
        // 这通常发生在所有模型都是满血状态（或状态完全一致）时，此时按状态分组没有意义
        if (statsMap.size === 1 && models.length > 1) {
            logger.info('Auto-grouping detected degenerate state (all models identical), falling back to ID-based fallback grouping.');
            return this.groupBasedOnSeries(models);
        }
        
        // 3. 正常情况：使用配额指纹生成映射
        const mappings: Record<string, string> = {};
        for (const [, modelIds] of statsMap) {
            const stableGroupId = modelIds.sort().join('_');
            for (const modelId of modelIds) {
                mappings[modelId] = stableGroupId;
            }
        }
        
        return mappings;
    }

    /**
     * 基于模型ID的硬编码兜底分组逻辑
     */
    private static groupBasedOnSeries(models: ModelQuotaInfo[]): Record<string, string> {
        const seriesMap = new Map<string, string[]>();

        // 定义硬编码的分组规则
        const GROUPS = {
            GEMINI: ['MODEL_PLACEHOLDER_M8', 'MODEL_PLACEHOLDER_M7'],
            GEMINI_FLASH: ['MODEL_PLACEHOLDER_M18'],
            CLAUDE_GPT: [
                'MODEL_CLAUDE_4_5_SONNET',
                'MODEL_CLAUDE_4_5_SONNET_THINKING',
                'MODEL_PLACEHOLDER_M12', // Claude Opus 4.5 Thinking
                'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
            ],
        };

        for (const model of models) {
            const id = model.modelId;
            let groupName = 'Other';

            if (GROUPS.GEMINI.includes(id)) {
                groupName = 'Gemini';
            } else if (GROUPS.GEMINI_FLASH.includes(id)) {
                groupName = 'Gemini Flash';
            } else if (GROUPS.CLAUDE_GPT.includes(id)) {
                groupName = 'Claude';
            }

            if (!seriesMap.has(groupName)) {
                seriesMap.set(groupName, []);
            }
            seriesMap.get(groupName)!.push(id);
        }

        const mappings: Record<string, string> = {};
        for (const [, modelIds] of seriesMap) {
            const stableGroupId = modelIds.sort().join('_');
            for (const modelId of modelIds) {
                mappings[modelId] = stableGroupId;
            }
        }
        return mappings;
    }
}

// 保持向后兼容
export type quota_snapshot = QuotaSnapshot;
export type model_quota_info = ModelQuotaInfo;
