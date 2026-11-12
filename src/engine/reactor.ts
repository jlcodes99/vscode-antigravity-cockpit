/**
 * Antigravity Cockpit - 反应堆核心
 * 负责与 Antigravity API 通信，获取配额数据
 */

import * as https from 'https';
import { computeModelAdoption, resolveAuthorizedOrderedModelKeys } from './model_catalog';
import { collapseLocalQuotaVariants, mergeAuthorizedModels, matchLocalAccount } from './local_quota';
import { AUTH_MODEL_BLACKLIST_IDS } from '../shared/recommended_models';
import { 
    QuotaSnapshot,
    ModelQuotaInfo,
    PromptCreditsInfo,
    ServerUserStatusResponse,
    ClientModelConfig,
    QuotaGroup,
    QuotaWindow,
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
    readDesktopQuotaApiCache,
    writeQuotaApiCache,
    isApiCacheValid,
    type QuotaApiCacheRecord,
} from '../services/quota_api_cache';


interface AuthorizedQuotaInfo {
    remainingFraction?: number;
    resetTime?: string;
    quotaBucketType?: string | number;
    type?: string | number;
    displayName?: string;
    name?: string;
    label?: string;
}

interface AuthorizedModelInfo {
    displayName?: string;
    model?: string;
    disabled?: boolean;
    quotaInfo?: AuthorizedQuotaInfo;
    quotaInfos?: unknown;
    quotaBuckets?: unknown;
    quotaBucket?: unknown;
    quotaLimits?: unknown;
    quotaWindows?: unknown;
    quotaGroup?: unknown;
    quotaGroupId?: string;
    quotaGroupName?: string;
    quotaPool?: unknown;
    quotaPoolId?: string;
    quotaPoolName?: string;
    modelProvider?: string;
    apiProvider?: string;
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

interface AuthorizedModelSortGroup {
    modelIds?: string[];
}

interface AuthorizedModelSort {
    displayName?: string;
    groups?: AuthorizedModelSortGroup[];
}

interface AuthorizedQuotaResponse {
    models?: Record<string, AuthorizedModelInfo>;
    agentModelSorts?: AuthorizedModelSort[];
    quota_summary?: unknown;
    quotaSummary?: unknown;
}

export interface AccountQuotaFetchResult {
    snapshot: QuotaSnapshot;
    fromApiCacheFile: boolean;
}

const AUTH_MODEL_BLACKLIST_ID_SET = new Set(AUTH_MODEL_BLACKLIST_IDS);
const KNOWN_MODEL_IDS_STATE_KEY = 'knownModelIds';
const ARGON_WEEKLY_BUCKET_ID = 'gemini-argon-wtu-weekly';
const ARGON_GROUP_ID = 'official:gemini-4-argon';
const ARGON_GROUP_NAME = 'Gemini 4 Argon';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(record: UnknownRecord, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}

function readNumberField(record: UnknownRecord, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string' && value.trim()) {
            const parsed = Number(value.trim());
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
    }
    return undefined;
}

function readStringOrNumberField(record: UnknownRecord, keys: string[]): string | number | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}

function sanitizeQuotaId(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'quota';
}

function isArgonWeeklyBucketId(id: string): boolean {
    return id === 'argon-weekly' || /^gemini-argon-(?:.+-)?weekly$/.test(id);
}

function isArgonShortBucketId(id: string): boolean {
    return id === 'argon-5h' || /^gemini-argon-(?:.+-)?5h$/.test(id);
}

function isArgonModel(model: ModelQuotaInfo): boolean {
    return /(?:gemini[-\s]+(?:4[-\s]+)?argon|model_placeholder_m41[789])/i.test(`${model.modelId} ${model.label}`);
}

function normalizeProviderLabel(value: string): string {
    return value
        .replace(/^MODEL_PROVIDER_/i, '')
        .replace(/^API_PROVIDER_/i, '')
        .replace(/_VERTEX$/i, '')
        .replace(/_GEMINI$/i, '')
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, char => char.toUpperCase())
        .trim();
}

function normalizeQuotaBucketType(value: string | number | undefined): string | number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        if (value === 0) {
            return 'SHORT_TERM';
        }
        if (value === 1) {
            return 'LONG_TERM';
        }
        return value;
    }
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.trim().toUpperCase();
    if (!normalized) {
        return undefined;
    }
    if (
        normalized === '0'
        || normalized === '5H'
        || normalized === 'FIVE_HOUR'
        || normalized === 'FIVE_HOUR_LIMIT'
        || normalized === 'SHORT'
        || normalized === 'SHORT_TERM'
    ) {
        return 'SHORT_TERM';
    }
    if (
        normalized === '1'
        || normalized === 'WEEK'
        || normalized === 'WEEKLY'
        || normalized === 'WEEKLY_LIMIT'
        || normalized === 'LONG'
        || normalized === 'LONG_TERM'
    ) {
        return 'LONG_TERM';
    }
    return normalized;
}

function findQuotaMetricRecord(record: UnknownRecord): UnknownRecord | null {
    const candidates: unknown[] = [
        record,
        record.quotaInfo,
        record.quota_info,
        record.quota,
        record.limit,
        record.window,
        record.bucket,
    ];

    for (const candidate of candidates) {
        if (!isRecord(candidate)) {
            continue;
        }
        const hasQuotaMetric = readNumberField(candidate, ['remainingFraction', 'remaining_fraction', 'fraction', 'remaining']) !== undefined
            || readStringField(candidate, ['resetTime', 'reset_time', 'resetTimestamp', 'reset_timestamp']) !== undefined;
        if (hasQuotaMetric) {
            return candidate;
        }
    }

    return null;
}


/**
 * 反应堆核心类
 * 管理与后端 API 的通信
 */
export class ReactorCore {
    private port: number = 0;
    private token: string = '';
    private localRescanHandler?: () => Promise<boolean>;
    private lastLocalRescanAt = 0;

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
    private lastLocalArgonBucket?: UnknownRecord;
    /** 上一次的授权配额模型缓存（用于 reprocess 时重新生成分组） */
    private lastAuthorizedModels?: ModelQuotaInfo[];
    private lastAuthorizedModelsAccount?: string | null;
    /** 上一次的官方配额摘要缓存（用于显示周额度 / 5 小时额度） */
    private lastAuthorizedQuotaSummary?: unknown;
    /** 最近一次成功获取到的授权 Credits（用于缓存重放时避免回退为 --） */
    private lastAuthorizedCredits?: { account: string; amount: number };
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
        if (this.port !== port || this.token !== token) {
            this.lastRawResponse = undefined;
        }
        this.port = port;
        this.token = token;
        this.lastScanDiagnostics = diagnostics;
        logger.info(`Reactor Engaged: :${port}`);
    }

    hasLocalConnection(): boolean {
        return this.port > 0 && Boolean(this.token);
    }

    setLocalRescanHandler(handler: () => Promise<boolean>): void {
        this.localRescanHandler = handler;
    }

    private async rescanLocalConnection(): Promise<boolean> {
        this.lastLocalRescanAt = Date.now();
        try {
            if (await this.localRescanHandler?.()) {
                return true;
            }
        } catch (error) {
            logger.debug(`[LocalQuota] Rescan failed: ${String(error)}`);
        }
        this.port = 0;
        this.token = '';
        this.lastRawResponse = undefined;
        return false;
    }

    /** Only this request's successful, identified local response may enrich an account. */
    async fetchMatchingLocalTelemetry(email?: string | null): Promise<QuotaSnapshot | null> {
        if (!email) {
            return null;
        }
        if (this.localRescanHandler && Date.now() - this.lastLocalRescanAt > 15000) {
            await this.rescanLocalConnection();
        }
        let snapshot = await this.tryFetchLocalTelemetry();
        if (!snapshot && this.hasLocalConnection() && this.localRescanHandler) {
            if (await this.rescanLocalConnection()) {
                snapshot = await this.tryFetchLocalTelemetry();
            }
        }
        return matchLocalAccount(snapshot, email);
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
            const localSnapshot = await this.fetchMatchingLocalTelemetry(email);
            const models = mergeAuthorizedModels(
                this.buildModelsFromAuthorizedResponse(record!.payload as AuthorizedQuotaResponse),
                localSnapshot,
                email,
            );
            const quotaSummary = await this.resolveQuotaSummary(email, record!.payload as AuthorizedQuotaResponse);
            if (models.length === 0 && !this.findArgonWeeklyBucket(quotaSummary)) {
                return false;
            }
            if (this.normalizeAccount(await credentialStorage.getActiveAccount()) !== this.normalizeAccount(email)) {
                return false;
            }
            this.lastAuthorizedModels = models;
            this.lastAuthorizedModelsAccount = email;
            this.lastAuthorizedQuotaSummary = quotaSummary;
            const telemetry = this.buildSnapshot(
                models,
                undefined,
                undefined,
                this.getCachedAuthorizedAvailableAICredits(email),
                quotaSummary,
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
            const snapshot = this.buildSnapshot(
                models,
                undefined,
                undefined,
                availableAICredits,
                modelsResult.quotaSummary,
            );
            
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
                    const activeAccount = await credentialStorage.getActiveAccount();
                    if (this.lastAuthorizedModels && this.normalizeAccount(activeAccount) === this.normalizeAccount(this.lastAuthorizedModelsAccount)) {
                        const cacheAge = this.getCacheAgeMs('authorized');
                        const ageNote = cacheAge !== undefined ? ` (age=${Math.round(cacheAge / 1000)}s)` : '';
                        logger.warn(`[AuthorizedQuota] Request failed, using cached models${ageNote}`);
                        const telemetry = this.buildSnapshot(
                            this.lastAuthorizedModels,
                            undefined,
                            undefined,
                            this.getCachedAuthorizedAvailableAICredits(activeAccount),
                            this.lastAuthorizedQuotaSummary,
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
        if (this.localRescanHandler && Date.now() - this.lastLocalRescanAt > 15000) {
            await this.rescanLocalConnection();
        }
        try {
            return await this.fetchLocalTelemetry();
        } catch (error) {
            if (this.localRescanHandler && await this.rescanLocalConnection()) {
                return await this.fetchLocalTelemetry();
            }
            throw error;
        }
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
        const email = raw?.userStatus?.email;
        const nativeArgonBucket = this.findArgonWeeklyBucket(raw?.userStatus?.quotaSummary ?? raw?.quotaSummary);
        const cachedArgonBucket = !nativeArgonBucket && email?.includes('@') ? await this.readCachedArgonWeeklyBucket(email) : undefined;
        this.lastRawResponse = raw; // 缓存原始响应
        this.lastLocalArgonBucket = cachedArgonBucket;
        this.lastLocalFetchedAt = Date.now();
        return this.decodeSignal(raw, this.getLocalArgonSummary(raw));
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
        if (source === 'authorized' && telemetry.isConnected) {
            telemetry.quotaAccountEmail = this.lastAuthorizedModelsAccount ?? undefined;
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
        const activeAccount = await credentialStorage.getActiveAccount();
        const tokenResult = activeAccount
            ? await oauthService.getAccessTokenStatusForAccount(activeAccount)
            : await oauthService.getAccessTokenStatus();
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

        let projectId: string | undefined;
        let availableAICredits: number | undefined;
        const credential = activeAccount
            ? await credentialStorage.getCredentialForAccount(activeAccount)
            : await credentialStorage.getCredential();
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
            }
        } catch (error) {
            if (error instanceof CloudCodeAuthError) {
                throw error;
            }
            const err = error instanceof Error ? error : new Error(String(error));
            logger.warn(`[AuthorizedQuota] loadCodeAssist failed, continuing without project: ${err.message}`);
        }

        const modelsResult = await this.fetchAuthorizedQuotaModelsWithSource(
            accessToken,
            projectId,
            activeAccount ?? undefined,
            false,
            credential?.isGcpTos,
        );
        const models = modelsResult.models;
        const activeAccountAfter = await credentialStorage.getActiveAccount();
        if (this.normalizeAccount(activeAccount) !== this.normalizeAccount(activeAccountAfter)) {
            logger.info('[AuthorizedQuota] Active account changed during fetch, retrying with new account');
            this.lastAuthorizedModels = undefined;
            this.lastAuthorizedQuotaSummary = undefined;
            // 递归重试，获取新账号的配额
            return this.fetchAuthorizedTelemetry(retryCount + 1);
        }
        this.lastAuthorizedModels = models;
        this.lastAuthorizedModelsAccount = activeAccount;
        this.lastAuthorizedQuotaSummary = modelsResult.quotaSummary;
        const account = this.normalizeAccount(activeAccount);
        if (account && availableAICredits !== undefined) {
            this.lastAuthorizedCredits = { account, amount: availableAICredits };
        }

        const snapshot = this.buildSnapshot(
            models,
            undefined,
            undefined,
            Number.isFinite(availableAICredits)
                ? Math.max(0, Number(availableAICredits))
                : this.getCachedAuthorizedAvailableAICredits(activeAccount),
            modelsResult.quotaSummary,
        );
        const localSnapshot = modelsResult.localSnapshot;
        if (localSnapshot) {
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

    private getCachedAuthorizedAvailableAICredits(email = this.lastAuthorizedModelsAccount): number | undefined {
        return this.lastAuthorizedCredits?.account === this.normalizeAccount(email)
            ? this.lastAuthorizedCredits.amount
            : undefined;
    }

    private normalizeRemainingFraction(value: unknown): number | undefined {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return undefined;
        }
        if (value < 0 || value > 1) {
            return undefined;
        }
        return value;
    }

    private inferQuotaWindowIdentity(
        resetTime: Date,
        resetTimeValid: boolean,
        now: number,
        quotaBucketType?: string | number,
    ): { windowId: string; windowName: string } {
        const normalizedBucketType = normalizeQuotaBucketType(quotaBucketType);
        if (normalizedBucketType === 'LONG_TERM') {
            return { windowId: 'long-term', windowName: 'Weekly Limit' };
        }
        if (normalizedBucketType === 'SHORT_TERM') {
            return { windowId: 'short-term', windowName: 'Five Hour Limit' };
        }

        if (resetTimeValid) {
            const deltaMs = resetTime.getTime() - now;
            if (deltaMs > 0 && deltaMs <= 6 * 60 * 60 * 1000) {
                return { windowId: 'short-term', windowName: 'Five Hour Limit' };
            }
            if (deltaMs >= 24 * 60 * 60 * 1000) {
                return { windowId: 'long-term', windowName: 'Weekly Limit' };
            }
        }

        return { windowId: 'model-quota', windowName: 'Model Quota' };
    }

    private parseQuotaWindow(raw: unknown, fallbackId: string, fallbackName: string, now: number): QuotaWindow | null {
        if (!isRecord(raw)) {
            return null;
        }

        const metricRecord = findQuotaMetricRecord(raw);
        if (!metricRecord) {
            return null;
        }

        const remainingFraction = this.normalizeRemainingFraction(
            readNumberField(metricRecord, ['remainingFraction', 'remaining_fraction', 'fraction', 'remaining']),
        );
        const resetTimeRaw = readStringField(metricRecord, ['resetTime', 'reset_time', 'resetTimestamp', 'reset_timestamp']);
        const rawBucketType = readStringOrNumberField(raw, ['quotaBucketType', 'bucketType', 'type', 'window', 'quota_bucket_type'])
            ?? readStringOrNumberField(metricRecord, ['quotaBucketType', 'bucketType', 'type', 'window', 'quota_bucket_type']);
        const rawId = readStringField(raw, ['id', 'key', 'quotaBucketId', 'bucketId', 'windowId']);
        const bucketId = rawId ? sanitizeQuotaId(rawId) : '';
        const isArgonWeekly = isArgonWeeklyBucketId(bucketId);
        let quotaBucketType = normalizeQuotaBucketType(rawBucketType);
        if (isArgonWeekly || /^(gemini|3p)-weekly$/.test(bucketId)) {
            quotaBucketType = 'LONG_TERM';
        } else if (isArgonShortBucketId(bucketId) || /^(gemini|3p)-5h$/.test(bucketId)) {
            quotaBucketType = 'SHORT_TERM';
        }
        if (isArgonWeekly && remainingFraction === undefined) {
            return null;
        }

        let resetTime = new Date(0);
        let resetTimeValid = false;
        if (resetTimeRaw) {
            const parsed = new Date(resetTimeRaw);
            if (!Number.isNaN(parsed.getTime())) {
                resetTime = parsed;
                resetTimeValid = parsed.getTime() > now;
            }
        }

        const inferred = this.inferQuotaWindowIdentity(resetTime, resetTimeValid, now, quotaBucketType);
        const rawName = readStringField(raw, ['displayName', 'name', 'label', 'windowName']);
        const windowId = isArgonWeekly ? ARGON_WEEKLY_BUCKET_ID : (bucketId || fallbackId || inferred.windowId);
        const windowName = isArgonWeekly ? 'Gemini 4 Argon (Weekly)' : (rawName || fallbackName || inferred.windowName);
        const remainingPercentage = remainingFraction !== undefined ? remainingFraction * 100 : 0;
        const timeUntilReset = resetTimeValid ? Math.max(0, resetTime.getTime() - now) : 0;

        return {
            windowId,
            windowName,
            remainingFraction,
            remainingPercentage,
            isExhausted: remainingFraction === 0,
            resetTime,
            timeUntilReset,
            timeUntilResetFormatted: resetTimeValid ? this.formatDelta(timeUntilReset) : (t('dashboard.online') || 'Quota available'),
            resetTimeDisplay: resetTimeValid ? this.formatIso(resetTime) : (t('common.unknown') || 'Unknown'),
            resetTimeValid,
            quotaBucketType,
            source: quotaBucketType || rawId || rawName ? 'official' : 'inferred',
        };
    }

    private collectQuotaWindowRecords(info: AuthorizedModelInfo): Array<{ raw: unknown; source: 'official' | 'modelQuota' }> {
        const records: Array<{ raw: unknown; source: 'official' | 'modelQuota' }> = [];
        const officialFields: unknown[] = [
            info.quotaBuckets,
            info.quotaBucket,
            info.quotaLimits,
            info.quotaWindows,
            info.quotaInfos,
        ];

        for (const field of officialFields) {
            if (Array.isArray(field)) {
                for (const item of field) {
                    records.push({ raw: item, source: 'official' });
                }
                continue;
            }
            if (isRecord(field)) {
                const hasQuotaShape = readNumberField(field, ['remainingFraction', 'remaining_fraction', 'fraction', 'remaining']) !== undefined
                    || readStringField(field, ['resetTime', 'reset_time', 'resetTimestamp', 'reset_timestamp']) !== undefined;
                if (hasQuotaShape) {
                    records.push({ raw: field, source: 'official' });
                } else {
                    for (const item of Object.values(field)) {
                        records.push({ raw: item, source: 'official' });
                    }
                }
            }
        }

        if (records.length === 0 && info.quotaInfo) {
            records.push({ raw: info.quotaInfo, source: 'modelQuota' });
        }

        return records;
    }

    private buildQuotaWindowsForAuthorizedModel(info: AuthorizedModelInfo, now: number): QuotaWindow[] {
        const windows: QuotaWindow[] = [];
        const seen = new Set<string>();

        for (const entry of this.collectQuotaWindowRecords(info)) {
            const parsed = this.parseQuotaWindow(entry.raw, '', '', now);
            if (!parsed) {
                continue;
            }
            const key = `${parsed.windowId}:${parsed.resetTime.getTime()}:${parsed.remainingPercentage}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            windows.push({
                ...parsed,
                source: entry.source === 'official' ? parsed.source : 'modelQuota',
            });
        }

        windows.sort((a, b) => this.getQuotaWindowRank(a) - this.getQuotaWindowRank(b));
        return windows;
    }

    private getQuotaWindowRank(window: QuotaWindow): number {
        const bucketType = normalizeQuotaBucketType(window.quotaBucketType);
        if (bucketType === 'LONG_TERM' || window.windowId === 'long-term') {
            return 0;
        }
        if (bucketType === 'SHORT_TERM' || window.windowId === 'short-term') {
            return 1;
        }
        return 10;
    }

    private resolveAuthorizedQuotaGroup(info: AuthorizedModelInfo): { groupId?: string; groupName?: string } {
        const directId = info.quotaGroupId || info.quotaPoolId;
        const directName = info.quotaGroupName || info.quotaPoolName;
        if (directId || directName) {
            return {
                groupId: directId ? `official:${sanitizeQuotaId(directId)}` : undefined,
                groupName: directName,
            };
        }

        for (const field of [info.quotaGroup, info.quotaPool]) {
            if (!isRecord(field)) {
                continue;
            }
            const id = readStringField(field, ['id', 'groupId', 'poolId', 'key']);
            const name = readStringField(field, ['displayName', 'name', 'label', 'groupName', 'poolName']);
            if (id || name) {
                return {
                    groupId: id ? `official:${sanitizeQuotaId(id)}` : undefined,
                    groupName: name,
                };
            }
        }

        return {};
    }

    private resolveQuotaGroupForModel(model: ModelQuotaInfo): { groupId: string; groupName: string; providerGroup?: string } {
        if (model.quotaGroupId || model.quotaGroupName) {
            const groupName = model.quotaGroupName || model.quotaGroupId || 'Model Quota';
            return {
                groupId: model.quotaGroupId || `official:${sanitizeQuotaId(groupName)}`,
                groupName,
            };
        }

        const providerText = [
            model.modelProvider,
            model.apiProvider,
            model.modelId,
            model.label,
        ].filter(Boolean).join(' ').toLowerCase();

        if (providerText.includes('google') || providerText.includes('gemini')) {
            return {
                groupId: 'provider:gemini-models',
                groupName: 'Gemini Models',
                providerGroup: 'gemini',
            };
        }

        if (
            providerText.includes('anthropic')
            || providerText.includes('claude')
            || providerText.includes('openai')
            || providerText.includes('gpt')
        ) {
            return {
                groupId: 'provider:claude-gpt-models',
                groupName: 'Claude and GPT models',
                providerGroup: 'claude-gpt',
            };
        }

        const providerName = model.modelProvider
            ? normalizeProviderLabel(model.modelProvider)
            : model.apiProvider
                ? normalizeProviderLabel(model.apiProvider)
                : 'Other';
        return {
            groupId: `provider:${sanitizeQuotaId(providerName)}`,
            groupName: `${providerName} Models`,
            providerGroup: sanitizeQuotaId(providerName),
        };
    }

    private getQuotaSummaryFromResponse(data: AuthorizedQuotaResponse): unknown {
        return data.quota_summary ?? data.quotaSummary;
    }

    private findArgonWeeklyBucket(summary: unknown, now?: number): UnknownRecord | undefined {
        if (!isRecord(summary) || !Array.isArray(summary.groups)) {
            return undefined;
        }
        for (const group of summary.groups) {
            if (!isRecord(group) || !Array.isArray(group.buckets)) {
                continue;
            }
            for (const bucket of group.buckets) {
                if (!isRecord(bucket)) {
                    continue;
                }
                const id = readStringField(bucket, ['bucketId', 'quotaBucketId', 'id', 'key']) ?? '';
                if (isArgonWeeklyBucketId(sanitizeQuotaId(id))) {
                    const window = this.parseQuotaWindow(bucket, '', '', now ?? Date.now());
                    if (window && (now === undefined || window.resetTimeValid)) {
                        return bucket;
                    }
                }
            }
        }
        return undefined;
    }

    private async readCachedArgonWeeklyBucket(email: string): Promise<UnknownRecord | undefined> {
        const records = await Promise.all([readQuotaApiCache('authorized', email), readDesktopQuotaApiCache('authorized', email)]);
        const now = Date.now();
        for (const record of records.filter(record => record !== null).sort((a, b) => b.updatedAt - a.updatedAt)) {
            if (this.normalizeAccount(record.email) !== this.normalizeAccount(email) || !isRecord(record.payload)) {
                continue;
            }
            const bucket = this.findArgonWeeklyBucket(this.getQuotaSummaryFromResponse(record.payload), now);
            if (bucket) {
                return bucket;
            }
        }
        return undefined;
    }

    private async resolveQuotaSummary(
        email: string | undefined,
        response?: AuthorizedQuotaResponse,
    ): Promise<unknown> {
        const responseSummary = response ? this.getQuotaSummaryFromResponse(response) : undefined;
        if (!email || this.findArgonWeeklyBucket(responseSummary)) {
            return responseSummary;
        }

        const desktopCache = await readDesktopQuotaApiCache('authorized', email);
        const desktopPayload = desktopCache?.payload;
        const desktopSummary = this.normalizeAccount(desktopCache?.email) === this.normalizeAccount(email) && isRecord(desktopPayload)
            ? this.getQuotaSummaryFromResponse(desktopPayload)
            : undefined;
        if (desktopSummary && !responseSummary) {
            logger.info('[AuthorizedQuota] Using quota_summary from desktop cache fallback');
            return desktopSummary;
        }
        const argonBucket = this.findArgonWeeklyBucket(desktopSummary, Date.now());
        if (argonBucket && isRecord(responseSummary) && Array.isArray(responseSummary.groups)) {
            return { ...responseSummary, groups: [...responseSummary.groups, { buckets: [argonBucket] }] };
        }

        return responseSummary;
    }

    private getQuotaSummaryGroups(quotaSummary: unknown, now: number): Array<{
        groupId: string;
        groupName: string;
        description?: string;
        quotaWindows: QuotaWindow[];
    }> {
        if (!isRecord(quotaSummary) || !Array.isArray(quotaSummary.groups)) {
            return [];
        }

        const groups: Array<{
            groupId: string;
            groupName: string;
            description?: string;
            quotaWindows: QuotaWindow[];
        }> = [];
        let argonWeekly: QuotaWindow | undefined;

        for (const [index, rawGroup] of quotaSummary.groups.entries()) {
            if (!isRecord(rawGroup)) {
                continue;
            }
            const rawGroupName = readStringField(rawGroup, ['displayName', 'name', 'label', 'groupName'])
                || `Model Quota ${index + 1}`;
            const groupName = rawGroupName;
            const rawGroupId = readStringField(rawGroup, ['id', 'groupId', 'key'])
                || rawGroupName;
            const description = readStringField(rawGroup, ['description']);
            const rawBuckets = rawGroup.buckets
                ?? rawGroup.quotaBuckets
                ?? rawGroup.quotaWindows
                ?? rawGroup.windows
                ?? rawGroup.quotaLimits;
            const bucketList = Array.isArray(rawBuckets)
                ? rawBuckets
                : isRecord(rawBuckets)
                    ? Object.values(rawBuckets)
                    : [];
            const windows = bucketList
                .map((bucket, bucketIndex) => this.parseQuotaWindow(
                    bucket,
                    `${sanitizeQuotaId(groupName)}-${bucketIndex + 1}`,
                    '',
                    now,
                ))
                .filter((window): window is QuotaWindow => window !== null && window.remainingFraction !== undefined)
                .sort((a, b) => this.getQuotaWindowRank(a) - this.getQuotaWindowRank(b));
            argonWeekly ??= windows.find(window => window.windowId === ARGON_WEEKLY_BUCKET_ID);
            const quotaWindows = windows.filter(window => window.windowId !== ARGON_WEEKLY_BUCKET_ID && !isArgonShortBucketId(window.windowId));

            if (quotaWindows.length === 0) {
                continue;
            }

            groups.push({
                groupId: `official:${sanitizeQuotaId(rawGroupId)}`,
                groupName,
                description,
                quotaWindows,
            });
        }

        if (argonWeekly) {
            groups.push({ groupId: ARGON_GROUP_ID, groupName: ARGON_GROUP_NAME, quotaWindows: [argonWeekly] });
        }

        return groups;
    }

    private isModelInQuotaSummaryGroup(
        model: ModelQuotaInfo,
        summaryGroup: { groupId: string; groupName: string; description?: string },
        hasArgonGroup: boolean,
    ): boolean {
        if (summaryGroup.groupId === ARGON_GROUP_ID) {
            return isArgonModel(model);
        }
        if (hasArgonGroup && isArgonModel(model)) {
            return false;
        }
        const resolved = this.resolveQuotaGroupForModel(model);
        const groupText = `${summaryGroup.groupName} ${summaryGroup.description || ''}`.toLowerCase();
        const modelText = [
            model.modelProvider,
            model.apiProvider,
            model.modelId,
            model.label,
        ].filter(Boolean).join(' ').toLowerCase();

        if (groupText.includes('gemini') || groupText.includes('google')) {
            return resolved.providerGroup === 'gemini'
                || modelText.includes('gemini')
                || modelText.includes('google');
        }

        if (
            groupText.includes('claude')
            || groupText.includes('gpt')
            || groupText.includes('openai')
            || groupText.includes('anthropic')
        ) {
            return resolved.providerGroup === 'claude-gpt'
                || modelText.includes('claude')
                || modelText.includes('gpt')
                || modelText.includes('openai')
                || modelText.includes('anthropic');
        }

        return resolved.groupName.toLowerCase() === summaryGroup.groupName.toLowerCase();
    }

    private aggregateQuotaWindows(models: ModelQuotaInfo[]): QuotaWindow[] {
        const windowsById = new Map<string, QuotaWindow>();

        for (const model of models) {
            for (const window of model.quotaWindows ?? []) {
                const bucketType = normalizeQuotaBucketType(window.quotaBucketType);
                const key = `${bucketType ?? window.windowId}`;
                const existing = windowsById.get(key);
                if (!existing) {
                    windowsById.set(key, { ...window });
                    continue;
                }

                const isLower = window.remainingPercentage < existing.remainingPercentage;
                const isTieWithEarlierReset = window.remainingPercentage === existing.remainingPercentage
                    && window.resetTime.getTime() > 0
                    && (
                        existing.resetTime.getTime() <= 0
                        || window.resetTime.getTime() < existing.resetTime.getTime()
                    );
                if (isLower || isTieWithEarlierReset) {
                    windowsById.set(key, { ...window });
                }
            }
        }

        return Array.from(windowsById.values())
            .sort((a, b) => {
                const rankDelta = this.getQuotaWindowRank(a) - this.getQuotaWindowRank(b);
                if (rankDelta !== 0) {
                    return rankDelta;
                }
                return a.windowName.localeCompare(b.windowName);
            });
    }

    private buildQuotaGroups(models: ModelQuotaInfo[], quotaSummary?: unknown): QuotaGroup[] {
        const now = Date.now();
        const summaryGroups = this.getQuotaSummaryGroups(quotaSummary, now);
        if (summaryGroups.length > 0) {
            const hasArgonGroup = summaryGroups.some(group => group.groupId === ARGON_GROUP_ID);
            const assignedModelIds = new Set<string>();
            const officialGroups = summaryGroups
                .map(summaryGroup => {
                    const groupModels = models.filter(model => this.isModelInQuotaSummaryGroup(model, summaryGroup, hasArgonGroup));
                    for (const model of groupModels) {
                        assignedModelIds.add(model.modelId);
                    }
                    const primaryWindow = summaryGroup.quotaWindows.reduce((lowest, current) => (
                        current.remainingPercentage < lowest.remainingPercentage ? current : lowest
                    ));
                    return {
                        groupId: summaryGroup.groupId,
                        groupName: summaryGroup.groupName,
                        models: groupModels,
                        quotaWindows: summaryGroup.quotaWindows,
                        description: summaryGroup.description,
                        remainingPercentage: primaryWindow.remainingPercentage,
                        resetTime: primaryWindow.resetTime,
                        resetTimeDisplay: primaryWindow.resetTimeDisplay,
                        timeUntilResetFormatted: primaryWindow.timeUntilResetFormatted,
                        isExhausted: summaryGroup.quotaWindows.some(window => window.isExhausted),
                        providerGroup: undefined,
                    };
                })
                .filter(group => group.models.length > 0 || group.groupId === ARGON_GROUP_ID);

            const remainingModels = models.filter(model => !assignedModelIds.has(model.modelId));
            const fallbackGroups = remainingModels.length > 0
                ? this.buildProviderQuotaGroups(remainingModels)
                : [];

            return [...officialGroups, ...fallbackGroups]
                .sort((a, b) => {
                    const indexA = a.models.length ? models.indexOf(a.models[0]) : models.length;
                    const indexB = b.models.length ? models.indexOf(b.models[0]) : models.length;
                    return indexA - indexB;
                });
        }

        return this.buildProviderQuotaGroups(models);
    }

    private buildProviderQuotaGroups(models: ModelQuotaInfo[]): QuotaGroup[] {
        const groupMap = new Map<string, {
            groupId: string;
            groupName: string;
            models: ModelQuotaInfo[];
            providerGroup?: string;
            firstModelIndex: number;
        }>();

        models.forEach((model, index) => {
            const resolved = this.resolveQuotaGroupForModel(model);
            const existing = groupMap.get(resolved.groupId);
            if (existing) {
                existing.models.push(model);
                return;
            }
            groupMap.set(resolved.groupId, {
                groupId: resolved.groupId,
                groupName: resolved.groupName,
                models: [model],
                providerGroup: resolved.providerGroup,
                firstModelIndex: index,
            });
        });

        return Array.from(groupMap.values())
            .sort((a, b) => a.firstModelIndex - b.firstModelIndex)
            .map(group => {
                const quotaWindows = this.aggregateQuotaWindows(group.models);
                const fallbackPercentage = Math.min(...group.models.map(model => model.remainingPercentage ?? 0));
                const primaryWindow = quotaWindows.length > 0
                    ? quotaWindows.reduce((lowest, current) => (
                        current.remainingPercentage < lowest.remainingPercentage ? current : lowest
                    ))
                    : undefined;
                const firstModel = group.models[0];

                return {
                    groupId: group.groupId,
                    groupName: group.groupName,
                    models: group.models,
                    quotaWindows,
                    providerGroup: group.providerGroup,
                    remainingPercentage: primaryWindow?.remainingPercentage ?? fallbackPercentage,
                    resetTime: primaryWindow?.resetTime ?? firstModel.resetTime,
                    resetTimeDisplay: primaryWindow?.resetTimeDisplay ?? firstModel.resetTimeDisplay,
                    timeUntilResetFormatted: primaryWindow?.timeUntilResetFormatted ?? firstModel.timeUntilResetFormatted,
                    isExhausted: quotaWindows.length > 0
                        ? quotaWindows.some(window => window.isExhausted)
                        : group.models.some(model => model.isExhausted),
                };
            });
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
    ): Promise<{ models: ModelQuotaInfo[]; quotaSummary?: unknown; fromApiCacheFile: boolean; localSnapshot: QuotaSnapshot | null }> {
        const localSnapshot = await this.fetchMatchingLocalTelemetry(email);
        let previousCache: QuotaApiCacheRecord | null = null;
        if (email) {
            previousCache = await readQuotaApiCache('authorized', email);
        }

        if (email && !forceRefresh && isApiCacheValid(previousCache)) {
            try {
                const payload = previousCache!.payload as AuthorizedQuotaResponse;
                const quotaSummary = await this.resolveQuotaSummary(email, payload);
                if (quotaSummary) {
                    return {
                        models: mergeAuthorizedModels(this.buildModelsFromAuthorizedResponse(payload), localSnapshot, email),
                        localSnapshot,
                        quotaSummary,
                        fromApiCacheFile: true,
                    };
                }
                logger.info('[QuotaApiCache] Cached response has no quota_summary; refreshing official quota summary');
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

        try {
            const quotaSummary = await cloudCodeClient.retrieveUserQuotaSummary(
                accessToken,
                projectId,
                {
                    logLabel: 'AuthorizedQuotaSummary',
                    route: { isGcpTos },
                },
            );
            data.quota_summary = quotaSummary;
            logger.info('[AuthorizedQuota] retrieveUserQuotaSummary succeeded');
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.warn(`[AuthorizedQuota] retrieveUserQuotaSummary failed, continuing with per-model quotaInfo: ${err.message}`);
        }

        const models = mergeAuthorizedModels(this.buildModelsFromAuthorizedResponse(data), localSnapshot, email);
        const quotaSummary = await this.resolveQuotaSummary(email, data);
        if (quotaSummary) {
            data.quota_summary = quotaSummary;
        }

        if (email) {
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
            quotaSummary,
            localSnapshot,
            fromApiCacheFile: false,
        };
    }

    private buildModelsFromAuthorizedResponse(data: AuthorizedQuotaResponse): ModelQuotaInfo[] {
        const models: ModelQuotaInfo[] = [];
        const now = Date.now();

        if (!data.models) {
            return models;
        }

        const orderedKeys = resolveAuthorizedOrderedModelKeys(data, AUTH_MODEL_BLACKLIST_ID_SET);
        for (const modelKey of orderedKeys) {
            const info = data.models[modelKey];
            if (!info) {
                continue;
            }
            if (info.disabled) {
                continue;
            }

            const quotaWindows = this.buildQuotaWindowsForAuthorizedModel(info, now);
            const primaryWindow = quotaWindows.length > 0
                ? quotaWindows.reduce((lowest, current) => (
                    current.remainingPercentage < lowest.remainingPercentage ? current : lowest
                ))
                : undefined;
            const remainingFraction = primaryWindow?.remainingFraction;
            const resetTime = primaryWindow?.resetTime ?? new Date(0);
            const resetTimeValid = primaryWindow?.resetTimeValid === true;
            const timeUntilReset = primaryWindow?.timeUntilReset ?? 0;
            const modelId = info.model || modelKey;
            const label = info.displayName?.trim() || modelKey;
            const quotaGroup = this.resolveAuthorizedQuotaGroup(info);

            models.push({
                label,
                modelId,
                remainingFraction,
                remainingPercentage: remainingFraction !== undefined ? remainingFraction * 100 : undefined,
                isExhausted: remainingFraction === 0,
                resetTime,
                resetTimeDisplay: primaryWindow?.resetTimeDisplay ?? (resetTimeValid ? this.formatIso(resetTime) : (t('common.unknown') || 'Unknown')),
                timeUntilReset,
                timeUntilResetFormatted: primaryWindow?.timeUntilResetFormatted ?? (resetTimeValid ? this.formatDelta(timeUntilReset) : (t('dashboard.online') || 'Quota available')),
                resetTimeValid,
                supportsImages: info.supportsImages,
                isRecommended: info.recommended,
                tagTitle: info.tagTitle,
                supportedMimeTypes: info.supportedMimeTypes,
                modelProvider: info.modelProvider,
                apiProvider: info.apiProvider,
                quotaWindows,
                quotaGroupId: quotaGroup.groupId,
                quotaGroupName: quotaGroup.groupName,
            });
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
            const telemetry = this.decodeSignal(this.lastRawResponse, this.getLocalArgonSummary(this.lastRawResponse));
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
                this.lastAuthorizedQuotaSummary,
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
                this.lastAuthorizedQuotaSummary,
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
            const telemetry = this.decodeSignal(this.lastRawResponse, this.getLocalArgonSummary(this.lastRawResponse));
            this.publishTelemetry(telemetry, 'local');
            return true;
        }

        if (source === 'local' && this.localUsingRemoteApi && this.lastAuthorizedModels) {
            const telemetry = this.buildSnapshot(
                this.lastAuthorizedModels,
                undefined,
                undefined,
                this.getCachedAuthorizedAvailableAICredits(),
                this.lastAuthorizedQuotaSummary,
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
                this.lastAuthorizedQuotaSummary,
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

    private getLocalArgonSummary(raw: ServerUserStatusResponse): unknown {
        const cachedSummary = this.lastLocalArgonBucket ? { groups: [{ buckets: [this.lastLocalArgonBucket] }] } : undefined;
        const bucket = this.findArgonWeeklyBucket(raw?.userStatus?.quotaSummary ?? raw?.quotaSummary)
            ?? this.findArgonWeeklyBucket(cachedSummary, Date.now());
        return bucket ? { groups: [{ buckets: [bucket] }] } : undefined;
    }

    /** 解码服务端响应 */
    private decodeSignal(data: ServerUserStatusResponse, quotaSummary?: unknown): QuotaSnapshot {
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
            availablePromptCredits: credits,
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
                const nowMs = now.getTime();
                let reset = new Date(m.quotaInfo.resetTime);
                let resetTimeValid = true;
                if (Number.isNaN(reset.getTime())) {
                    reset = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                    resetTimeValid = false;
                    logger.warn(`[ReactorCore] Invalid resetTime for model ${m.label}: ${m.quotaInfo.resetTime}`);
                }
                const delta = reset.getTime() - now.getTime();
                const parsedWindow = this.parseQuotaWindow(m.quotaInfo, '', '', nowMs);
                const quotaWindows = parsedWindow ? [{ ...parsedWindow, source: 'modelQuota' as const }] : [];

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
                    quotaWindows,
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

        this.logModelList('local', models);
        return this.buildSnapshot(models, promptCredits, userInfo, undefined, quotaSummary, 'local');
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
        quotaSummary?: unknown,
        source: 'local' | 'authorized' = 'authorized',
    ): QuotaSnapshot {
        const config = configService.getConfig();
        const allModels = [...models];

        const visibleModels = this.adoptNewlyDiscoveredModels(allModels) ?? config.visibleModels ?? [];
        if (visibleModels.length > 0) {
            const visibleSet = new Set(visibleModels);
            const filteredModels = models.filter(model => visibleSet.has(model.modelId));

            // 安全检查：如果过滤后为空但原始列表不为空，可能是配置问题
            if (filteredModels.length === 0 && models.length > 0) {
                logger.warn('[buildSnapshot] Visible models filter resulted in empty list. ' +
                    `Original: ${models.length}, Visible config: ${visibleModels.length}. ` +
                    'Showing all recommended models instead.');
                // 不应用 visibleModels 过滤，但保留推荐模型过滤
                void configService.updateVisibleModels([]);
            } else {
                models = filteredModels;
            }
        }

        const displayModels = source === 'local' ? collapseLocalQuotaVariants(models, config.pinnedModels ?? []) : models;
        const groups = this.buildQuotaGroups(displayModels, quotaSummary);
        logger.debug(`Official quota groups created: ${groups.length}`);

        // 将配额中的模型常量传递给 AutoTriggerController，用于过滤可触发模型
        const quotaModelConstants = models.map(m => m.modelId);
        autoTriggerController.setQuotaModels(quotaModelConstants);

        return {
            timestamp: new Date(),
            availableAICredits,
            promptCredits,
            userInfo,
            models: displayModels,
            allModels,
            groups,
            isConnected: true,
        };
    }

    public buildAuthorizedSnapshotFromResponse(
        data: unknown,
        updatedAt?: number,
        targetEmail?: string,
        localSnapshot?: QuotaSnapshot | null,
    ): QuotaSnapshot {
        const response = data as AuthorizedQuotaResponse;
        const models = mergeAuthorizedModels(this.buildModelsFromAuthorizedResponse(response), localSnapshot, targetEmail);
        const snapshot = this.buildSnapshot(
            models,
            undefined,
            undefined,
            targetEmail ? this.getCachedAuthorizedAvailableAICredits(targetEmail) : undefined,
            this.getQuotaSummaryFromResponse(response),
        );
        if (updatedAt) {
            snapshot.timestamp = new Date(updatedAt);
        }
        return snapshot;
    }

    public async buildCachedAuthorizedSnapshot(
        record: QuotaApiCacheRecord,
        email: string,
        localSnapshot: QuotaSnapshot | null,
    ): Promise<QuotaSnapshot> {
        const response = record.payload as AuthorizedQuotaResponse;
        const summary = await this.resolveQuotaSummary(email, response);
        return this.buildAuthorizedSnapshotFromResponse({ ...response, quota_summary: summary }, record.updatedAt, email, localSnapshot);
    }

    private adoptNewlyDiscoveredModels(models: ModelQuotaInfo[]): string[] | null {
        if (models.length === 0) {
            return null;
        }
        const stored = configService.getStateValue<string[]>(KNOWN_MODEL_IDS_STATE_KEY);
        const result = computeModelAdoption({
            currentIds: models.map(model => model.modelId),
            storedIds: stored,
            visibleIds: configService.getConfig().visibleModels ?? [],
            blacklist: AUTH_MODEL_BLACKLIST_ID_SET,
        });
        if (stored === undefined || result.newIds.length > 0) {
            void configService.setStateValue(KNOWN_MODEL_IDS_STATE_KEY, result.nextKnownIds);
        }
        if (result.mergedVisibleIds) {
            void configService.updateVisibleModels(result.mergedVisibleIds);
        }
        return result.mergedVisibleIds;
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

}

// 保持向后兼容
export type quota_snapshot = QuotaSnapshot;
export type model_quota_info = ModelQuotaInfo;
