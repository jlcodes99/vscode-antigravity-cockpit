/**
 * Antigravity Cockpit - 反应堆核心
 * 负责与 Antigravity API 通信，获取配额数据
 */

import * as https from 'https';
import * as vscode from 'vscode';
import { 
    QuotaSnapshot, 
    ModelQuotaInfo, 
    PromptCreditsInfo, 
    ServerUserStatusResponse,
    ClientModelConfig,
    QuotaGroup,
} from '../shared/types';
import { logger } from '../shared/log_service';
import { configService } from '../shared/config_service';
import { t } from '../shared/i18n';
import { TIMING, API_ENDPOINTS } from '../shared/constants';

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
    
    /** 已通知过配额耗尽的模型 */
    private exhaustedNotifiedModels: Set<string> = new Set();
    /** 已通知过低配额警告的模型 */
    private warningNotifiedModels: Set<string> = new Set();
    /** 上一次的配额快照缓存 */
    private lastSnapshot?: QuotaSnapshot;
    /** 上一次的原始 API 响应缓存（用于 reprocess 时重新生成分组） */
    private lastRawResponse?: ServerUserStatusResponse;

    constructor() {
        logger.debug('ReactorCore Online');
    }

    /**
     * 启动反应堆，设置连接参数
     */
    engage(port: number, token: string): void {
        this.port = port;
        this.token = token;
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

                    try {
                        resolve(JSON.parse(body) as T);
                    } catch (e) {
                        const error = e instanceof Error ? e : new Error(String(e));
                        reject(new Error(`Signal Corrupted: ${error.message}`));
                    }
                });
            });

            req.on('error', (e) => reject(new Error(`Connection Failed: ${e.message}`)));
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Signal Lost: Request timed out'));
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

        this.syncTelemetry();

        this.pulseTimer = setInterval(() => {
            this.syncTelemetry();
        }, interval);
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
     * 同步遥测数据
     */
    async syncTelemetry(): Promise<void> {
        try {
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
            const telemetry = this.decodeSignal(raw);
            this.lastSnapshot = telemetry; // Cache the latest snapshot

            // 打印关键配额信息
            const maxLabelLen = Math.max(...telemetry.models.map(m => m.label.length));
            const quotaSummary = telemetry.models.map(m => {
                const pct = m.remainingPercentage !== undefined ? m.remainingPercentage.toFixed(2) + '%' : 'N/A';
                return `    ${m.label.padEnd(maxLabelLen)} : ${pct}`;
            }).join('\n');
            
            logger.info(`Quota Update:\n${quotaSummary}`);

            // 检查并发送配额通知
            this.checkAndNotify(telemetry);

            if (this.updateHandler) {
                this.updateHandler(telemetry);
            }
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`Telemetry Sync Failed: ${err.message}`);
            if (this.errorHandler) {
                this.errorHandler(err);
            }
        }
    }

    /**
     * 重新发布最近一次的遥测数据
     * 用于在配置变更等不需要重新请求 API 的场景下更新 UI
     */
    reprocess(): void {
        if (this.lastRawResponse && this.updateHandler) {
            logger.info('Reprocessing cached telemetry data with latest config');
            // 重新调用 decodeSignal 以根据最新配置生成分组
            const telemetry = this.decodeSignal(this.lastRawResponse);
            this.lastSnapshot = telemetry;
            this.updateHandler(telemetry);
        } else if (this.lastSnapshot && this.updateHandler) {
            // 如果没有原始响应，回退到旧的行为
            logger.info('Reprocessing cached snapshot (no raw response)');
            this.updateHandler(this.lastSnapshot);
        } else {
            logger.warn('Cannot reprocess: no cached data available');
        }
    }

    /**
     * 检查是否有缓存数据
     */
    get hasCache(): boolean {
        return !!this.lastSnapshot;
    }

    /**
     * 检查配额并发送通知
     */
    private checkAndNotify(snapshot: QuotaSnapshot): void {
        const config = configService.getConfig();
        if (!config.notificationEnabled) {
            return;
        }

        for (const model of snapshot.models) {
            const percentage = model.remainingPercentage ?? 100;

            // 配额耗尽通知
            if (model.isExhausted && !this.exhaustedNotifiedModels.has(model.modelId)) {
                this.exhaustedNotifiedModels.add(model.modelId);
                vscode.window.showWarningMessage(
                    t('notify.exhausted', { 
                        model: model.label, 
                        time: model.timeUntilResetFormatted, 
                    }),
                );
            }

            // 低配额警告（仅警告一次）- 使用配置的阈值
            const warningThreshold = config.warningThreshold;
            if (percentage > 0 && percentage <= warningThreshold && 
                !this.warningNotifiedModels.has(model.modelId)) {
                this.warningNotifiedModels.add(model.modelId);
                vscode.window.showInformationMessage(
                    t('notify.warning', { 
                        model: model.label, 
                        percent: percentage.toFixed(0), 
                    }),
                );
            }

            // 配额恢复后重置通知状态
            if (percentage > warningThreshold) {
                this.exhaustedNotifiedModels.delete(model.modelId);
                this.warningNotifiedModels.delete(model.modelId);
            }
        }
    }

    /**
     * 解码服务端响应
     */
    private decodeSignal(data: ServerUserStatusResponse): QuotaSnapshot {
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

        const userInfo: import('../shared/types').UserInfo = {
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
                const reset = new Date(m.quotaInfo.resetTime);
                const now = new Date();
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
                    resetTimeDisplay: this.formatIso(reset),
                    timeUntilReset: delta,
                    timeUntilResetFormatted: this.formatDelta(delta),
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

        // 分组逻辑：使用存储的 groupMappings 进行分组
        const config = configService.getConfig();
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

        return {
            timestamp: new Date(),
            promptCredits,
            userInfo,
            models,
            groups,
            isConnected: true,
        };
    }

    /**
     * 格式化日期为 ISO 格式
     */
    private formatIso(d: Date): string {
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    /**
     * 格式化时间差
     */
    private formatDelta(ms: number): string {
        if (ms <= 0) {
            return t('dashboard.online');
        }
        const m = Math.ceil(ms / 60000);
        if (m < 60) {
            return `${m}m`;
        }
        const h = Math.floor(m / 60);
        return `${h}h ${m % 60}m`;
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
        const mappings: Record<string, string> = {};
        const groupMap = new Map<string, string[]>();
        
        // 根据配额指纹进行分组
        for (const model of models) {
            const fingerprint = `${model.remainingFraction?.toFixed(6)}_${model.resetTime.getTime()}`;
            if (!groupMap.has(fingerprint)) {
                groupMap.set(fingerprint, []);
            }
            groupMap.get(fingerprint)!.push(model.modelId);
        }
        
        // 为每个组生成稳定的 groupId
        for (const [, modelIds] of groupMap) {
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
