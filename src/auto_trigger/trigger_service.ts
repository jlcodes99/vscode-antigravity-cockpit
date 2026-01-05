/**
 * Antigravity Cockpit - Trigger Service
 * 触发服务：执行自动对话触发
 */

import { oauthService, AccessTokenResult } from './oauth_service';
import { credentialStorage } from './credential_storage';
import { TriggerRecord, ModelInfo } from './types';
import { logger } from '../shared/log_service';
import { cloudCodeClient } from '../shared/cloudcode_client';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RESET_TRIGGER_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_TRIGGER_CONCURRENCY = 4;

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
    /** 记录每个模型上次 remaining，用于检测满额上升沿 */
    private lastResetRemaining: Map<string, number> = new Map();

    /**
     * 初始化：从存储加载历史记录
     */
    initialize(): void {
        this.loadHistory();
        this.loadResetTriggerTimestamps();
        this.loadResetTriggerAt();
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
     * @param modelId 模型 ID
     * @param resetAt 当前的重置时间点 (ISO 8601)
     * @param remaining 当前剩余配额
     * @param limit 配额上限
     * @returns true 如果应该触发
     */
    shouldTriggerOnReset(modelId: string, resetAt: string, remaining: number, limit: number): boolean {
        const lastRemaining = this.lastResetRemaining.get(modelId);
        const isFull = remaining >= limit;

        // 只有满额时才考虑触发
        if (!isFull) {
            this.lastResetRemaining.set(modelId, remaining);
            logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} not full (${remaining}/${limit})`);
            return false;
        }

        const lastTriggeredResetAt = this.lastResetTriggerTimestamps.get(modelId);
        logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} lastTriggeredResetAt=${lastTriggeredResetAt}, current resetAt=${resetAt}`);

        const lastTriggerAt = this.lastResetTriggerAt.get(modelId);
        if (lastTriggerAt !== undefined && Date.now() - lastTriggerAt < RESET_TRIGGER_COOLDOWN_MS) {
            this.lastResetRemaining.set(modelId, remaining);
            logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} cooldown active, skip`);
            return false;
        }

        // 启动首次观察到满额时，允许补触发一次
        if (lastRemaining === undefined) {
            if (resetAt === lastTriggeredResetAt) {
                this.lastResetRemaining.set(modelId, remaining);
                logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} startup full but resetAt same, skip`);
                return false;
            }
            this.lastResetRemaining.set(modelId, remaining);
            logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} startup full, allow once`);
            return true;
        }

        const wasBelowLimit = lastRemaining < limit;
        const isRisingEdge = wasBelowLimit && isFull;
        if (!isRisingEdge) {
            this.lastResetRemaining.set(modelId, remaining);
            logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} not rising edge (last=${lastRemaining}, current=${remaining})`);
            return false;
        }

        // 如果 resetAt 变化了（新的重置周期），则应该触发
        if (resetAt === lastTriggeredResetAt) {
            this.lastResetRemaining.set(modelId, remaining);
            logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} resetAt same, skip`);
            return false;
        }

        this.lastResetRemaining.set(modelId, remaining);
        logger.debug(`[TriggerService] shouldTriggerOnReset: ${modelId} resetAt changed, rising edge, should trigger`);
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
    ): Promise<TriggerRecord> {
        const startTime = Date.now();
        const triggerModels = (models && models.length > 0) ? models : ['gemini-3-flash'];
        const promptText = customPrompt || 'hi';  // 使用自定义或默认唤醒词
        let stage = 'start';
        
        logger.info(`[TriggerService] Starting trigger (${triggerType}) for models: ${triggerModels.join(', ')}, prompt: "${promptText}"...`);

        try {
            // 1. 获取有效的 access_token
            stage = 'get_access_token';
            const tokenResult = await this.getAccessTokenResult();
            if (tokenResult.state !== 'ok' || !tokenResult.token) {
                throw new Error(`No valid access token (${tokenResult.state}). Please authorize first.`);
            }
            const accessToken = tokenResult.token;

            // 2. 获取 project_id
            stage = 'get_project_id';
            const credential = await credentialStorage.getCredential();
            const projectId = credential?.projectId || await this.fetchProjectId(accessToken);

            // 3. 发送触发请求
            const results: Array<{
                model: string;
                ok: boolean;
                message: string;
                duration: number;
            }> = new Array(triggerModels.length);
            let nextIndex = 0;

            const worker = async () => {
                while (true) {
                    const currentIndex = nextIndex++;
                    if (currentIndex >= triggerModels.length) {
                        return;
                    }
                    const model = triggerModels[currentIndex];
                    const started = Date.now();
                    try {
                        stage = `send_trigger_request:${model}`;
                        const reply = await this.sendTriggerRequest(accessToken, projectId, model, promptText);
                        results[currentIndex] = {
                            model,
                            ok: true,
                            message: reply,
                            duration: Date.now() - started,
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
                .map(result => `${result.model}: ${result.message} (${result.duration}ms)`);
            const failureLines = results
                .filter(result => !result.ok)
                .map(result => `${result.model}: ERROR ${result.message} (${result.duration}ms)`);
            const summary = [...successLines, ...failureLines].join('\n');
            const successCount = successLines.length;
            const failureCount = failureLines.length;
            const hasSuccess = successCount > 0;

            // 4. 记录成功
            const record: TriggerRecord = {
                timestamp: new Date().toISOString(),
                success: hasSuccess,
                prompt: `[${triggerModels.join(', ')}] ${promptText}`,
                message: summary,
                duration: Date.now() - startTime,
                triggerType: triggerType,
                triggerSource: triggerSource || (triggerType === 'manual' ? 'manual' : undefined),
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
            logger.error(`[TriggerService] Trigger failed (stage=${stage}, source=${sourceLabel}, models=${triggerModels.join(', ')}): ${err.message}`);
            
            // 记录失败
            const record: TriggerRecord = {
                timestamp: new Date().toISOString(),
                success: false,
                prompt: `[${triggerModels.join(', ')}] ${promptText}`,
                message: err.message,
                duration: Date.now() - startTime,
                triggerType: triggerType,
                triggerSource: triggerSource || (triggerType === 'manual' ? 'manual' : undefined),
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
    private async fetchProjectId(accessToken: string): Promise<string> {
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
            const credential = await credentialStorage.getCredential();
            if (credential) {
                credential.projectId = projectId;
                await credentialStorage.saveCredential(credential);
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
    async fetchAvailableModels(filterByConstants?: string[]): Promise<ModelInfo[]> {
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

        // 如果提供了过滤列表，按顺序返回匹配的模型
        if (filterByConstants && filterByConstants.length > 0) {
            // 建立 modelConstant -> ModelInfo 的映射
            const modelMap = new Map<string, ModelInfo>();
            for (const model of allModels) {
                if (model.modelConstant) {
                    modelMap.set(model.modelConstant, model);
                }
            }
            
            // 按照 filterByConstants 的顺序返回
            const sorted: ModelInfo[] = [];
            for (const constant of filterByConstants) {
                const model = modelMap.get(constant);
                if (model) {
                    sorted.push(model);
                }
            }
            
            logger.debug(`[TriggerService] Filtered models (sorted): ${sorted.map(m => m.displayName).join(', ')}`);
            return sorted;
        }

        logger.debug(`[TriggerService] All available models: ${allModels.map(m => m.displayName).join(', ')}`);
        return allModels;
    }

    /**
     * 发送触发请求
     * 发送一条简短的消息来触发配额计时
     * @param prompt 唤醒词，默认 "hi"
     * @returns AI 的简短回复
     */
    private async sendTriggerRequest(accessToken: string, projectId: string, model: string, prompt: string = 'hi'): Promise<string> {
        const sessionId = this.generateSessionId();
        const requestId = this.generateRequestId();

        const requestBody = {
            project: projectId,
            requestId: requestId,
            model: model,
            userAgent: 'antigravity',
            request: {
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: prompt }],  // 使用自定义唤醒词
                    },
                ],
                session_id: sessionId,
                // 不限制输出长度，让模型自然回复
            },
        };

        let result: { data: any; text: string; status: number };
        try {
            result = await cloudCodeClient.requestJson(
                '/v1internal:generateContent',
                requestBody,
                accessToken,
                { logLabel: 'TriggerService', timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
            );
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            throw new Error(`API request failed (generateContent): ${err.message}`);
        }

        const text = result.text || JSON.stringify(result.data);
        // 输出完整响应，便于调试
        logger.info(`[TriggerService] generateContent response: ${text.substring(0, 2000)}`);
        
        try {
            const data = result.data;
            // Antigravity API 响应结构：data.response.candidates[0].content.parts[0].text
            // 或者直接：data.candidates[0].content.parts[0].text
            const candidates = data?.response?.candidates || data?.candidates;
            const reply = candidates?.[0]?.content?.parts?.[0]?.text || '(无回复)';
            return reply.trim();
        } catch {
            return '(收到非 JSON 响应)';
        }
    }

    private async getAccessTokenResult(): Promise<AccessTokenResult> {
        const result = await oauthService.getAccessTokenStatus();
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
}

// 导出单例
export const triggerService = new TriggerService();
