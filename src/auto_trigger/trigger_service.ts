/**
 * Antigravity Cockpit - Trigger Service
 * 触发服务：执行自动对话触发
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { oauthService, AccessTokenResult } from './oauth_service';
import { credentialStorage } from './credential_storage';
import { TriggerRecord, ModelInfo } from './types';
import { logger } from '../shared/log_service';
import { cloudCodeClient } from '../shared/cloudcode_client';
import { t } from '../shared/i18n';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RESET_TRIGGER_COOLDOWN_MS = 10 * 60 * 1000;
const RESET_SAFETY_MARGIN_MS = 2 * 60 * 1000;  // 2 分钟安全边际，确保服务端已完成重置
const MAX_TRIGGER_CONCURRENCY = 4;
const DEFAULT_MAX_OUTPUT_TOKENS = 0;  // 0 means no limit
const ANTIGRAVITY_SYSTEM_PROMPT = 'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**';
const AVAILABLE_MODELS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const AVAILABLE_MODELS_CACHE_VERSION = 1;
const AVAILABLE_MODELS_CACHE_FILE = path.join(
    os.homedir(),
    '.antigravity_cockpit',
    'cache',
    'available_models.json',
);

interface AvailableModelsCache {
    version: number;
    updatedAt: number;
    models: ModelInfo[];
}

/**
 * 触发服务
 * 负责发送对话请求以触发配额重置周期
 */
class TriggerService {
    private recentTriggers: TriggerRecord[] = [];
    private readonly maxRecords = 40;  // 最多保留 40 条
    private readonly maxDays = 7;      // 最多保留 7 天
    private readonly storageKey = 'triggerHistory';
    private readonly resetTriggerKey = 'lastResetTriggerTimestamps';
    private readonly resetTriggerAtKey = 'lastResetTriggerAt';
    
    /** 记录每个模型上次触发时对应的 resetAt，防止重复触发 */
    private lastResetTriggerTimestamps: Map<string, string> = new Map();
    /** 记录每个模型上次触发时间（用于冷却） */
    private lastResetTriggerAt: Map<string, number> = new Map();

    /**
     * 初始化：从存储加载历史记录
     */
    initialize(): void {
        this.loadHistory();
        this.loadResetTriggerTimestamps();
        this.loadResetTriggerAt();
    }

    async refreshAvailableModelsCache(): Promise<ModelInfo[]> {
        return this.fetchAvailableModels(undefined, { forceRefresh: true });
    }
    
    /**
     * 加载重置触发时间戳记录
     */
    private loadResetTriggerTimestamps(): void {
        const saved = credentialStorage.getState<Record<string, string>>(this.resetTriggerKey, {});
        this.lastResetTriggerTimestamps = new Map(Object.entries(saved));
        logger.debug(`[TriggerService] Loaded ${this.lastResetTriggerTimestamps.size} reset trigger timestamps`);
    }
    
    /**
     * 保存重置触发时间戳记录
     */
    private saveResetTriggerTimestamps(): void {
        const obj = Object.fromEntries(this.lastResetTriggerTimestamps);
        credentialStorage.saveState(this.resetTriggerKey, obj);
    }

    /**
     * 加载重置触发时间记录（冷却）
     */
    private loadResetTriggerAt(): void {
        const saved = credentialStorage.getState<Record<string, number>>(this.resetTriggerAtKey, {});
        this.lastResetTriggerAt = new Map(
            Object.entries(saved).map(([key, value]) => [key, Number(value)]),
        );
        logger.debug(`[TriggerService] Loaded ${this.lastResetTriggerAt.size} reset trigger timestamps (cooldown)`);
    }

    /**
     * 保存重置触发时间记录（冷却）
     */
    private saveResetTriggerAt(): void {
        const obj = Object.fromEntries(this.lastResetTriggerAt);
        credentialStorage.saveState(this.resetTriggerAtKey, obj);
    }
    
    /**
     * 检查是否应该在配额重置时触发唤醒
     * 
     * 触发条件（全部满足）：
     * 1. 满额：remaining >= limit
     * 2. 时间边际：now >= lastResetAt + 2分钟（确保服务端已完成重置，避免滑动误触发）
     * 3. 冷却：距上次触发 >= 10分钟
     * 4. resetAt 变化：resetAt !== lastResetAt
     * 
     * @param modelId 模型 ID
     * @param resetAt 当前的重置时间点 (ISO 8601)
     * @param remaining 当前剩余配额
     * @param limit 配额上限
     * @returns true 如果应该触发
     */
    shouldTriggerOnReset(modelId: string, resetAt: string, remaining: number, limit: number): boolean {
        // 条件 1：满额检测
        const isFull = remaining >= limit;
        if (!isFull) {
            logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} not full (${remaining}/${limit})`);
            return false;
        }

        const now = Date.now();
        const lastTriggeredResetAt = this.lastResetTriggerTimestamps.get(modelId);
        logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} lastTriggeredResetAt=${lastTriggeredResetAt}, current resetAt=${resetAt}`);

        // 条件 2：时间边际检测
        // 只有当上次记录的 resetAt 时间点 + 安全边际已过去，才认为是新周期
        // 这可以防止 resetAt 滑动时的误触发，以及确保服务端已完成重置
        if (lastTriggeredResetAt) {
            const lastResetTime = new Date(lastTriggeredResetAt).getTime();
            const safeTime = lastResetTime + RESET_SAFETY_MARGIN_MS;
            if (now < safeTime) {
                const waitSec = Math.ceil((safeTime - now) / 1000);
                logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} waiting for safety margin (${waitSec}s left)`);
                return false;
            }
        }

        // 条件 3：冷却检测
        const lastTriggerAt = this.lastResetTriggerAt.get(modelId);
        if (lastTriggerAt !== undefined && now - lastTriggerAt < RESET_TRIGGER_COOLDOWN_MS) {
            logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} cooldown active, skip`);
            return false;
        }

        // 条件 4：resetAt 变化检测
        if (resetAt === lastTriggeredResetAt) {
            logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} resetAt same, skip`);
            return false;
        }

        logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} all conditions met, should trigger`);
        return true;
    }
    
    /**
     * 记录已触发的重置时间点
     */
    markResetTriggered(modelId: string, resetAt: string): void {
        this.lastResetTriggerTimestamps.set(modelId, resetAt);
        this.saveResetTriggerTimestamps();
        this.lastResetTriggerAt.set(modelId, Date.now());
        this.saveResetTriggerAt();
        logger.info(`[TriggerService] Marked reset triggered for ${modelId} at ${resetAt}`);
    }

    /**
     * 从存储加载历史记录
     */
    private loadHistory(): void {
        const saved = credentialStorage.getState<TriggerRecord[]>(this.storageKey, []);
        this.recentTriggers = this.cleanupRecords(saved);
        logger.debug(`[TriggerService] Loaded ${this.recentTriggers.length} history records`);
    }

    /**
     * 保存历史记录到存储
     */
    private saveHistory(): void {
        credentialStorage.saveState(this.storageKey, this.recentTriggers);
    }

    /**
     * 清理过期记录（超过 7 天或超过 40 条）
     */
    private cleanupRecords(records: TriggerRecord[]): TriggerRecord[] {
        const now = Date.now();
        const maxAge = this.maxDays * 24 * 60 * 60 * 1000;  // 7 天的毫秒数
        
        // 过滤掉超过 7 天的记录
        const filtered = records.filter(record => {
            const recordTime = new Date(record.timestamp).getTime();
            return (now - recordTime) < maxAge;
        });
        
        // 限制最多 40 条
        return filtered.slice(0, this.maxRecords);
    }

    /**
     * 执行触发
     * 发送一条简短的对话消息以触发配额计时
     * @param models 要触发的模型列表，如果不传则使用默认
     */
    async trigger(
        models?: string[],
        triggerType: 'manual' | 'auto' = 'manual',
        customPrompt?: string,
        triggerSource?: 'manual' | 'scheduled' | 'crontab' | 'quota_reset',
        accountEmail?: string,
        maxOutputTokens?: number,
    ): Promise<TriggerRecord> {
        const startTime = Date.now();
        const triggerModels = (models && models.length > 0) ? models : ['gemini-3-flash'];
        const promptText = customPrompt || 'hi';  // 使用自定义或默认唤醒词
        const resolvedMaxOutputTokens = this.normalizeMaxOutputTokens(maxOutputTokens);
        let stage = 'start';
        const accountLabel = accountEmail ? ` (${accountEmail})` : '';
        
        logger.info(`[TriggerService] Starting trigger (${triggerType})${accountLabel} for models: ${triggerModels.join(', ')}, prompt: "${promptText}"...`);

        try {
            // 1. 获取有效的 access_token
            stage = 'get_access_token';
            const tokenResult = await this.getAccessTokenResult(accountEmail);
            if (tokenResult.state !== 'ok' || !tokenResult.token) {
                throw new Error(`No valid access token (${tokenResult.state}). Please authorize first.`);
            }
            const accessToken = tokenResult.token;

            // 2. 获取 project_id
            stage = 'get_project_id';
            const credential = accountEmail
                ? await credentialStorage.getCredentialForAccount(accountEmail)
                : await credentialStorage.getCredential();
            const projectId = credential?.projectId || await this.fetchProjectId(accessToken, accountEmail);

            // 3. 发送触发请求
            const results: Array<{
                model: string;
                ok: boolean;
                message: string;
                duration: number;
                promptTokens?: number;
                completionTokens?: number;
                totalTokens?: number;
                traceId?: string;
            }> = new Array(triggerModels.length);
            let nextIndex = 0;

            const worker = async () => {
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    const currentIndex = nextIndex++;
                    if (currentIndex >= triggerModels.length) {
                        return;
                    }
                    const model = triggerModels[currentIndex];
                    const started = Date.now();
                    try {
                        stage = `send_trigger_request:${model}`;
                        const reply = await this.sendTriggerRequest(accessToken, projectId, model, promptText, resolvedMaxOutputTokens);
                        results[currentIndex] = {
                            model,
                            ok: true,
                            message: reply.reply,
                            duration: Date.now() - started,
                            promptTokens: reply.promptTokens,
                            completionTokens: reply.completionTokens,
                            totalTokens: reply.totalTokens,
                            traceId: reply.traceId,
                        };
                    } catch (error) {
                        const err = error instanceof Error ? error : new Error(String(error));
                        results[currentIndex] = {
                            model,
                            ok: false,
                            message: err.message,
                            duration: Date.now() - started,
                        };
                    }
                }
            };

            const workerCount = Math.min(MAX_TRIGGER_CONCURRENCY, triggerModels.length);
            await Promise.all(Array.from({ length: workerCount }, () => worker()));

            const successLines = results
                .filter(result => result.ok)
                .map(result => {
                    const tokensLabel = (result.promptTokens !== undefined || result.totalTokens !== undefined)
                        ? `, tokens=${result.promptTokens ?? '?'}+${result.completionTokens ?? '?'}=${result.totalTokens ?? '?'}`
                        : '';
                    const traceLabel = result.traceId ? `, traceId=${result.traceId}` : '';
                    return `[[${result.model}]]: ${result.message} (${result.duration}ms${tokensLabel}${traceLabel})`;
                });
            const failureLines = results
                .filter(result => !result.ok)
                .map(result => `[[${result.model}]]: ERROR ${result.message} (${result.duration}ms)`);
            const summary = [...successLines, ...failureLines].join('\n\n');
            const successCount = successLines.length;
            const failureCount = failureLines.length;
            const hasSuccess = successCount > 0;

            // 4. 记录成功
            const tokensSummary = results.find(r => r.totalTokens !== undefined);
            const record: TriggerRecord = {
                timestamp: new Date().toISOString(),
                success: hasSuccess,
                prompt: `唤醒词：${promptText}`,
                message: summary,
                duration: Date.now() - startTime,
                totalTokens: tokensSummary?.totalTokens,
                promptTokens: tokensSummary?.promptTokens,
                completionTokens: tokensSummary?.completionTokens,
                traceId: tokensSummary?.traceId,
                triggerType: triggerType,
                triggerSource: triggerSource || (triggerType === 'manual' ? 'manual' : undefined),
                accountEmail: accountEmail,
            };

            this.addRecord(record);
            if (hasSuccess && failureCount === 0) {
                logger.info(`[TriggerService] Trigger successful in ${record.duration}ms`);
            } else if (hasSuccess) {
                logger.warn(`[TriggerService] Trigger completed with partial failures (success=${successCount}, failed=${failureCount}) in ${record.duration}ms`);
            } else {
                logger.error(`[TriggerService] Trigger failed for all models (count=${failureCount}) in ${record.duration}ms`);
            }
            return record;

        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            const sourceLabel = triggerSource ?? triggerType;
            logger.error(`[TriggerService] Trigger failed${accountLabel} (stage=${stage}, source=${sourceLabel}, models=${triggerModels.join(', ')}): ${err.message}`);
            
            // 记录失败
            const record: TriggerRecord = {
                timestamp: new Date().toISOString(),
                success: false,
                prompt: `唤醒词：${promptText}`,
                message: err.message,
                duration: Date.now() - startTime,
                traceId: undefined,
                triggerType: triggerType,
                triggerSource: triggerSource || (triggerType === 'manual' ? 'manual' : undefined),
                accountEmail: accountEmail,
            };

            this.addRecord(record);
            logger.error(`[TriggerService] Trigger failed: ${err.message}`);
            return record;
        }
    }

    /**
     * 获取最近的触发记录
     */
    getRecentTriggers(): TriggerRecord[] {
        return [...this.recentTriggers];
    }

    /**
     * 获取最后一次触发记录
     */
    getLastTrigger(): TriggerRecord | undefined {
        return this.recentTriggers[0];
    }

    /**
     * 清空历史记录
     */
    clearHistory(): void {
        this.recentTriggers = [];
        this.saveHistory();
        logger.info('[TriggerService] History cleared');
    }

    /**
     * 添加触发记录
     */
    private addRecord(record: TriggerRecord): void {
        this.recentTriggers.unshift(record);
        // 清理并限制数量
        this.recentTriggers = this.cleanupRecords(this.recentTriggers);
        // 持久化保存
        this.saveHistory();
    }

    /**
     * 获取 project_id
     */
    private async fetchProjectId(accessToken: string, accountEmail?: string): Promise<string> {
        let projectId: string | undefined;
        try {
            const info = await cloudCodeClient.resolveProjectId(accessToken, {
                logLabel: 'TriggerService',
                timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
            });
            projectId = info.projectId;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.warn(`[TriggerService] Failed to resolve project_id: ${err.message}`);
        }

        if (projectId) {
            if (accountEmail) {
                await credentialStorage.updateProjectIdForAccount(accountEmail, projectId);
            } else {
                const credential = await credentialStorage.getCredential();
                if (credential) {
                    credential.projectId = projectId;
                    await credentialStorage.saveCredential(credential);
                }
            }
            return projectId;
        }

        logger.warn('[TriggerService] Failed to fetch project_id, using fallback');
        const randomId = Math.random().toString(36).substring(2, 10);
        return `projects/random-${randomId}/locations/global`;
    }

    /**
     * 获取可用模型列表
     * @param filterByConstants 可选，配额中显示的模型常量列表，用于过滤
     */
    async fetchAvailableModels(
        filterByConstants?: string[],
        options?: { forceRefresh?: boolean },
    ): Promise<ModelInfo[]> {
        const cached = !options?.forceRefresh ? await this.readAvailableModelsCache() : null;
        if (cached && this.isCacheFresh(cached) && cached.models.length > 0) {
            const filtered = this.filterModelsByConstants(cached.models, filterByConstants);
            if (filtered.length > 0) {
                logger.debug(`[TriggerService] Using cached available models: ${filtered.length}`);
                return filtered;
            }
        }
        const tokenResult = await this.getAccessTokenResult();
        if (tokenResult.state !== 'ok' || !tokenResult.token) {
            logger.debug(`[TriggerService] fetchAvailableModels: No access token (${tokenResult.state}), skipping`);
            return [];
        }
        const accessToken = tokenResult.token;

        let data: { models?: Record<string, { displayName?: string; model?: string }> } | undefined;
        try {
            data = await cloudCodeClient.fetchAvailableModels(
                accessToken,
                undefined,
                { logLabel: 'TriggerService', timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
            );
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.warn(`[TriggerService] fetchAvailableModels failed, returning empty: ${err.message}`);
            if (cached?.models?.length) {
                const filtered = this.filterModelsByConstants(cached.models, filterByConstants);
                if (filtered.length > 0) {
                    logger.debug('[TriggerService] Falling back to cached available models after failure');
                    return filtered;
                }
            }
            return [];
        }

        if (!data) {
            return [];
        }
        if (!data.models) {
            return [];
        }

        // 构建 ModelInfo 数组
        const allModels: ModelInfo[] = Object.entries(data.models).map(([id, info]) => ({
            id,
            displayName: info.displayName || id,
            modelConstant: info.model || '',
        }));

        if (allModels.length > 0) {
            await this.writeAvailableModelsCache(allModels);
        }
        const filtered = this.filterModelsByConstants(allModels, filterByConstants);
        if (filterByConstants && filterByConstants.length > 0) {
            logger.debug(`[TriggerService] Filtered models (sorted): ${filtered.map(m => m.displayName).join(', ')}`);
        } else {
            logger.debug(`[TriggerService] All available models: ${allModels.map(m => m.displayName).join(', ')}`);
        }
        return filtered;
    }

    private async readAvailableModelsCache(): Promise<AvailableModelsCache | null> {
        try {
            const content = await fs.readFile(AVAILABLE_MODELS_CACHE_FILE, 'utf8');
            const parsed = JSON.parse(content) as AvailableModelsCache;
            if (!parsed || parsed.version !== AVAILABLE_MODELS_CACHE_VERSION) {
                return null;
            }
            if (!Array.isArray(parsed.models)) {
                return null;
            }
            return parsed;
        } catch (error) {
            return null;
        }
    }

    private async writeAvailableModelsCache(models: ModelInfo[]): Promise<void> {
        try {
            await fs.mkdir(path.dirname(AVAILABLE_MODELS_CACHE_FILE), { recursive: true });
            const record: AvailableModelsCache = {
                version: AVAILABLE_MODELS_CACHE_VERSION,
                updatedAt: Date.now(),
                models,
            };
            const tempPath = `${AVAILABLE_MODELS_CACHE_FILE}.tmp`;
            await fs.writeFile(tempPath, JSON.stringify(record, null, 2), 'utf8');
            await fs.rename(tempPath, AVAILABLE_MODELS_CACHE_FILE);
        } catch (error) {
            logger.debug(`[TriggerService] Failed to write available models cache: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private isCacheFresh(cache: AvailableModelsCache): boolean {
        if (!cache.updatedAt || !Number.isFinite(cache.updatedAt)) {
            return false;
        }
        return Date.now() - cache.updatedAt < AVAILABLE_MODELS_CACHE_TTL_MS;
    }

    private filterModelsByConstants(models: ModelInfo[], filterByConstants?: string[]): ModelInfo[] {
        if (!filterByConstants || filterByConstants.length === 0) {
            return models;
        }
        const modelMap = new Map<string, ModelInfo>();
        for (const model of models) {
            if (model.modelConstant) {
                modelMap.set(model.modelConstant, model);
            }
        }
        const sorted: ModelInfo[] = [];
        for (const constant of filterByConstants) {
            const model = modelMap.get(constant);
            if (model) {
                sorted.push(model);
            }
        }
        return sorted;
    }

    private buildTriggerRequestBody(
        projectId: string,
        requestId: string,
        sessionId: string,
        model: string,
        prompt: string,
        maxOutputTokens: number,
    ) {
        return {
            project: projectId,
            requestId: requestId,
            model: model,
            userAgent: 'antigravity',
            requestType: 'agent',
            request: {
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: prompt }],
                    },
                ],
                session_id: sessionId,
                systemInstruction: {
                    parts: [{ text: ANTIGRAVITY_SYSTEM_PROMPT }],
                },
                generationConfig: {
                    // maxOutputTokens: 0 means no limit (don't include in request)
                    ...(maxOutputTokens > 0 ? { maxOutputTokens } : {}),
                    temperature: 0,
                },
            },
        };
    }

    private parseStreamResult(result: { data: unknown; text: string }): {
        reply: string;
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        traceId?: string;
        responseId?: string;
    } {
        const payloads = (result.text || '').split('\n').filter(Boolean);
        const replyParts: string[] = [];
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        let totalTokens: number | undefined;
        let traceId: string | undefined;
        let responseId: string | undefined;

        const processObj = (obj: unknown) => {
            const typedObj = obj as Record<string, unknown> | undefined;
            const response = typedObj?.response as Record<string, unknown> | undefined;
            const candidates = (response?.candidates || (typedObj as Record<string, unknown> | undefined)?.candidates) as Array<Record<string, unknown>> | undefined;
            const candidate = candidates?.[0];
            const content = candidate?.content as Record<string, unknown> | undefined;
            const parts = content?.parts;
            if (Array.isArray(parts)) {
                for (const part of parts) {
                    // Skip thinking content (thought summaries from Gemini thinking models)
                    if (part && part.thought === true) {
                        continue;
                    }
                    const text = (part && typeof part.text === 'string') ? part.text : undefined;
                    if (text) {
                        replyParts.push(text);
                    }
                }
            }

            const usage = (response?.usageMetadata || typedObj?.usageMetadata) as Record<string, number> | undefined;
            if (usage) {
                promptTokens ??= usage.promptTokenCount;
                completionTokens ??= usage.candidatesTokenCount;
                totalTokens ??= usage.totalTokenCount;
            }
            traceId ??= typedObj?.traceId as string | undefined;
            responseId ??= (response?.responseId || typedObj?.responseId) as string | undefined;
        };

        for (const line of payloads) {
            try {
                processObj(JSON.parse(line));
            } catch {
                // ignore parse errors per line
            }
        }

        // 如果没有从流中解析到，使用 data 兜底
        if (replyParts.length === 0 && result.data) {
            try {
                processObj(result.data);
            } catch {
                // ignore
            }
        }

        const reply = replyParts.join('') || t('autoTrigger.noReply');
        const normalizedCompletion = completionTokens ?? 0;
        return { reply, promptTokens, completionTokens: normalizedCompletion, totalTokens, traceId, responseId };
    }

    /**
     * 发送触发请求
     * 发送一条简短的消息来触发配额计时
     * @param prompt 唤醒词，默认 "hi"
     * @returns AI 的简短回复
     */
    private async sendTriggerRequest(
        accessToken: string,
        projectId: string,
        model: string,
        prompt: string = 'hi',
        maxOutputTokens: number,
    ): Promise<{
        reply: string;
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        traceId?: string;
        responseId?: string;
    }> {
        const sessionId = this.generateSessionId();
        const requestId = this.generateRequestId();

        const requestBody = this.buildTriggerRequestBody(projectId, requestId, sessionId, model, prompt, maxOutputTokens);

        let result: { data: unknown; text: string; status: number };
        try {
            result = await cloudCodeClient.requestStream(
                '/v1internal:streamGenerateContent?alt=sse',
                requestBody,
                accessToken,
                { logLabel: 'TriggerService', timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
            );
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            throw new Error(`API request failed (streamGenerateContent): ${err.message}`);
        }

        const text = result.text || JSON.stringify(result.data);
        // 输出完整响应，便于调试
        logger.info(`[TriggerService] streamGenerateContent response: ${text.substring(0, 2000)}`);

        const parsed = this.parseStreamResult(result);
        return parsed;
    }

    private async getAccessTokenResult(accountEmail?: string): Promise<AccessTokenResult> {
        const result = accountEmail
            ? await oauthService.getAccessTokenStatusForAccount(accountEmail)
            : await oauthService.getAccessTokenStatus();
        if (result.state === 'invalid_grant') {
            logger.warn('[TriggerService] Refresh token invalid (invalid_grant)');
        } else if (result.state === 'expired') {
            logger.warn('[TriggerService] Access token expired');
        } else if (result.state === 'refresh_failed') {
            logger.warn(`[TriggerService] Token refresh failed: ${result.error || 'unknown'}`);
        }
        return result;
    }

    private async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 生成 session_id
     */
    private generateSessionId(): string {
        return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    /**
     * 生成 request_id
     */
    private generateRequestId(): string {
        return `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    private normalizeMaxOutputTokens(value?: number): number {
        // 0 means no limit, negative or invalid values fall back to default
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            return DEFAULT_MAX_OUTPUT_TOKENS;
        }
        return Math.floor(value);
    }
}

// 导出单例
export const triggerService = new TriggerService();
