
import * as vscode from 'vscode';
import { ReactorCore } from '../engine/reactor';
import { StatusBarController } from './status_bar_controller';
import { CockpitHUD } from '../view/hud';
import { QuickPickView } from '../view/quickpick_view';
import { configService, CockpitConfig } from '../shared/config_service';
import { logger } from '../shared/log_service';
import { t } from '../shared/i18n';
import { QuotaSnapshot } from '../shared/types';
import { QUOTA_THRESHOLDS, TIMING } from '../shared/constants';
import { credentialStorage } from '../auto_trigger';
import { announcementService } from '../announcement';
import { recordQuotaHistory } from '../services/quota_history';


export class TelemetryController {
    private notifiedModels: Set<string> = new Set();
    private lastSuccessfulUpdate: Date | null = null;
    private consecutiveFailures: number = 0;

    constructor(
        private reactor: ReactorCore,
        private statusBar: StatusBarController,
        private hud: CockpitHUD,
        private quickPickView: QuickPickView,
        private onRetry: () => Promise<void>,
    ) {
        this.setupTelemetryHandling();
    }

    public resetNotifications(): void {
        this.notifiedModels.clear();
    }

    private setupTelemetryHandling(): void {
        this.reactor.onTelemetry(async (snapshot: QuotaSnapshot) => {
            const source = configService.getConfig().quotaSource;
            const authorizationStatus = await credentialStorage.getAuthorizationStatus();
            const config = configService.getConfig();
            if (this.reactor.getLatestSnapshot() !== snapshot || config.quotaSource !== source) {
                return;
            }
            if (source === 'authorized' && snapshot.quotaAccountEmail
                && snapshot.quotaAccountEmail.toLowerCase() !== authorizationStatus.activeAccount?.toLowerCase()) {
                return;
            }

            // 记录最后成功更新时间
            this.lastSuccessfulUpdate = new Date();
            this.consecutiveFailures = 0; // 重置连续失败计数

            // 成功获取数据，重置错误状态
            this.statusBar.reset();

            // 检查配额并发送通知
            this.checkAndNotifyQuota(snapshot, config);

            const authorizedAvailable = authorizationStatus.isAuthorized;

            // 更新 Dashboard（使用可能已更新的 config）
            this.hud.refreshView(snapshot, {
                showPromptCredits: config.showPromptCredits,
                pinnedModels: config.pinnedModels,
                pinnedGroups: config.pinnedGroups,
                modelOrder: config.modelOrder,
                groupOrder: config.groupOrder,
                modelCustomNames: config.modelCustomNames,
                groupingCustomNames: config.groupingCustomNames,
                groupingShowInStatusBar: config.groupingShowInStatusBar,
                visibleModels: config.visibleModels,
                refreshInterval: config.refreshInterval,
                notificationEnabled: config.notificationEnabled,
                warningThreshold: config.warningThreshold,
                criticalThreshold: config.criticalThreshold,
                lastSuccessfulUpdate: this.lastSuccessfulUpdate,
                statusBarFormat: config.statusBarFormat,
                profileHidden: config.profileHidden,
                quotaSource: config.quotaSource,
                authorizedAvailable,
                authorizationStatus,
                displayMode: config.displayMode,
                dataMasked: config.dataMasked,
                language: config.language,
                antigravityToolsSyncEnabled: configService.getStateFlag('antigravityToolsSyncEnabled', false),
            });

            const historyEmail = [snapshot.quotaAccountEmail, snapshot.userInfo?.email, snapshot.localAccountEmail]
                .find(email => email?.includes('@'));
            if (historyEmail) {
                void recordQuotaHistory(historyEmail, snapshot).then(changed => {
                    if (changed && this.hud.isVisible()) {
                        this.hud.sendMessage({
                            type: 'quotaHistoryUpdated',
                            data: { email: historyEmail },
                        });
                    }
                });
            }

            // 更新 QuickPick 视图数据
            this.quickPickView.updateSnapshot(snapshot);

            // 更新状态栏
            this.statusBar.update(snapshot, config);

            // 同步刷新公告状态（让面板打开时能自动接收新公告弹框）
            try {
                const annState = await announcementService.getState();
                this.hud.sendMessage({
                    type: 'announcementState',
                    data: annState,
                });
            } catch (error) {
                // 公告刷新失败不影响主流程
                logger.debug(`[TelemetryController] Announcement refresh failed: ${error}`);
            }

            // Auto sync is fixed OFF.
        });

        this.reactor.onMalfunction(async (err: Error) => {
            const source = (err as Error & { source?: string }).source;
            const sourceInfo = source ? ` (source=${source})` : '';
            logger.error(`Reactor Malfunction${sourceInfo}: ${err.message}`);

            // 如果是连接被拒绝（ECONNREFUSED），说明端口可能变了，或者信号中断/损坏，直接重新扫描
            if (err.message.includes('ECONNREFUSED') || 
                err.message.includes('Signal Lost') || 
                err.message.includes('Signal Corrupted')) {
                
                // 增加连续失败计数
                this.consecutiveFailures++;
                
                // 如果连续失败次数没超过阈值，尝试自动重连
                if (this.consecutiveFailures <= TIMING.MAX_CONSECUTIVE_RETRY) {
                    logger.warn(`Connection issue detected (attempt ${this.consecutiveFailures}/${TIMING.MAX_CONSECUTIVE_RETRY}), initiating immediate re-scan protocol...`);
                    // 立即尝试重新启动系统（重新扫描端口）
                    await this.onRetry();
                    return;
                } else {
                    logger.error(`Connection failed after ${this.consecutiveFailures} consecutive attempts. Stopping auto-retry.`);
                }
            }


            this.statusBar.setError(err.message);

            // 显示系统弹框
            vscode.window.showErrorMessage(
                `${t('notify.bootFailed')}: ${err.message}`,
                t('help.retry'),
                t('help.openLogs'),
            ).then(selection => {
                if (selection === t('help.retry')) {
                    vscode.commands.executeCommand('agCockpit.retry');
                } else if (selection === t('help.openLogs')) {
                    logger.show();
                }
            });
        });
    }

    private checkAndNotifyQuota(snapshot: QuotaSnapshot, config: CockpitConfig): void {
        if (!config.notificationEnabled) {
            return;
        }

        const warningThreshold = config.warningThreshold ?? QUOTA_THRESHOLDS.WARNING_DEFAULT;
        const criticalThreshold = config.criticalThreshold ?? QUOTA_THRESHOLDS.CRITICAL_DEFAULT;

        const useGroups = Array.isArray(snapshot.groups) && snapshot.groups.length > 0;
        if (useGroups) {
            for (const group of snapshot.groups!) {
                const pct = group.remainingPercentage ?? 0;
                const keyBase = `group:${group.groupId}`;
                const notifyKey = `${keyBase}-${pct <= criticalThreshold ? 'critical' : 'warning'}`;

                // 如果已经通知过这个状态，跳过
                if (this.notifiedModels.has(notifyKey)) {
                    continue;
                }

                // 危险阈值通知（红色）
                if (pct <= criticalThreshold && pct > 0) {
                    // 清除之前的 warning 通知记录（如果有）
                    this.notifiedModels.delete(`${keyBase}-warning`);
                    this.notifiedModels.add(notifyKey);

                    vscode.window.showWarningMessage(
                        t('threshold.notifyCritical', { model: group.groupName, percent: pct.toFixed(1) }),
                        t('dashboard.refresh'),
                    ).then(selection => {
                        if (selection === t('dashboard.refresh')) {
                            this.reactor.syncTelemetry();
                        }
                    });
                    logger.info(`Critical threshold notification sent for ${group.groupName}: ${pct}%`);
                }
                // 警告阈值通知（黄色）
                else if (pct <= warningThreshold && pct > criticalThreshold) {
                    this.notifiedModels.add(notifyKey);

                    vscode.window.showInformationMessage(
                        t('threshold.notifyWarning', { model: group.groupName, percent: pct.toFixed(1) }),
                    );
                    logger.info(`Warning threshold notification sent for ${group.groupName}: ${pct}%`);
                }
                // 配额恢复时清除通知记录
                else if (pct > warningThreshold) {
                    this.notifiedModels.delete(`${keyBase}-warning`);
                    this.notifiedModels.delete(`${keyBase}-critical`);
                }
            }
            return;
        }

        for (const model of snapshot.models) {
            const pct = model.remainingPercentage ?? 0;
            const notifyKey = `${model.modelId}-${pct <= criticalThreshold ? 'critical' : 'warning'}`;

            // 如果已经通知过这个状态，跳过
            if (this.notifiedModels.has(notifyKey)) {
                continue;
            }

            // 危险阈值通知（红色）
            if (pct <= criticalThreshold && pct > 0) {
                // 清除之前的 warning 通知记录（如果有）
                this.notifiedModels.delete(`${model.modelId}-warning`);
                this.notifiedModels.add(notifyKey);

                vscode.window.showWarningMessage(
                    t('threshold.notifyCritical', { model: model.label, percent: pct.toFixed(1) }),
                    t('dashboard.refresh'),
                ).then(selection => {
                    if (selection === t('dashboard.refresh')) {
                        this.reactor.syncTelemetry();
                    }
                });
                logger.info(`Critical threshold notification sent for ${model.label}: ${pct}%`);
            }
            // 警告阈值通知（黄色）
            else if (pct <= warningThreshold && pct > criticalThreshold) {
                this.notifiedModels.add(notifyKey);

                vscode.window.showInformationMessage(
                    t('threshold.notifyWarning', { model: model.label, percent: pct.toFixed(1) }),
                );
                logger.info(`Warning threshold notification sent for ${model.label}: ${pct}%`);
            }
            // 配额恢复时清除通知记录
            else if (pct > warningThreshold) {
                this.notifiedModels.delete(`${model.modelId}-warning`);
                this.notifiedModels.delete(`${model.modelId}-critical`);
            }
        }
    }

    /**
     * 后台自动同步 Antigravity Tools 账户（仅导入，不切换）
     */
    private async performAutoSync(): Promise<void> {
        return Promise.resolve();
    }
}
