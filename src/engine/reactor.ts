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
} from '../shared/types';
import { logger } from '../shared/log_service';
import { configService } from '../shared/config_service';
import { t } from '../shared/i18n';
import { TIMING, API_ENDPOINTS, QUOTA_THRESHOLDS } from '../shared/constants';

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
    
    /** 已通知过配额耗尽的模型 */
    private exhaustedNotifiedModels: Set<string> = new Set();
    /** 已通知过低配额警告的模型 */
    private warningNotifiedModels: Set<string> = new Set();

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

            const req = https.request(opts, res => {
                let body = '';
                res.on('data', c => (body += c));
                res.on('end', () => {
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

            const telemetry = this.decodeSignal(raw);

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

            // 低配额警告（仅警告一次）
            if (percentage > 0 && percentage <= QUOTA_THRESHOLDS.WARNING && 
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
            if (percentage > QUOTA_THRESHOLDS.WARNING) {
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

        const configs: ClientModelConfig[] = status.cascadeModelConfigData?.clientModelConfigs || [];

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

        return {
            timestamp: new Date(),
            promptCredits,
            models,
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
}

// 保持向后兼容
export type quota_snapshot = QuotaSnapshot;
export type model_quota_info = ModelQuotaInfo;
