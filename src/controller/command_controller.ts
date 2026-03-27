
import * as vscode from 'vscode';
import { CockpitHUD } from '../view/hud';
import { QuickPickView } from '../view/quickpick_view';
import { ReactorCore } from '../engine/reactor';
import { triggerService } from '../auto_trigger/trigger_service';
import { configService } from '../shared/config_service';
import { logger } from '../shared/log_service';
import { t } from '../shared/i18n';
import { DISPLAY_MODE, FEEDBACK_URL } from '../shared/constants';
import { announcementService } from '../announcement';

export class CommandController {
    constructor(
        private context: vscode.ExtensionContext,
        private hud: CockpitHUD,
        private quickPickView: QuickPickView,
        private reactor: ReactorCore,
        private onRetry: () => Promise<void>,
    ) {
        this.registerCommands();
    }

    private registerCommands(): void {
        // 打开 Dashboard 或账号总览（根据用户上次选择的视图）
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.open', async (options?: { tab?: string; forceView?: 'dashboard' | 'accountsOverview' }) => {
                const config = configService.getConfig();
                
                // 检查用户上次选择的视图状态
                const lastActiveView = configService.getStateValue<string>('lastActiveView', 'dashboard');
                const targetView = options?.forceView || lastActiveView;
                
                const targetTab = options?.tab ?? (targetView === 'accountsOverview' ? 'accounts' : 'quota');

                // 账号总览统一切到 HUD 的 Accounts Tab（不再打开独立 Webview）
                if (targetView === 'accountsOverview') {
                    logger.info('[CommandController] Opening Accounts tab (last active view)');
                    const success = await this.hud.revealHud(targetTab);
                    if (!success) {
                        const selection = await vscode.window.showWarningMessage(
                            t('webview.failedPrompt'),
                            t('webview.switchToQuickPick'),
                            t('webview.cancel'),
                        );
                        if (selection === t('webview.switchToQuickPick')) {
                            await configService.updateConfig('displayMode', DISPLAY_MODE.QUICKPICK);
                            vscode.window.showInformationMessage(t('webview.switchedToQuickPick'));
                            this.reactor.reprocess();
                            this.quickPickView.show();
                        }
                    }
                    return;
                }

                // 打开 Dashboard
                if (config.displayMode === DISPLAY_MODE.QUICKPICK) {
                    this.quickPickView.show();
                } else {
                    const success = await this.hud.revealHud(targetTab);
                    if (!success) {
                        // Webview 创建失败，引导用户切换到 QuickPick 模式
                        const selection = await vscode.window.showWarningMessage(
                            t('webview.failedPrompt'),
                            t('webview.switchToQuickPick'),
                            t('webview.cancel'),
                        );
                        if (selection === t('webview.switchToQuickPick')) {
                            await configService.updateConfig('displayMode', DISPLAY_MODE.QUICKPICK);
                            vscode.window.showInformationMessage(t('webview.switchedToQuickPick'));
                            this.reactor.reprocess();
                            this.quickPickView.show();
                        }
                    }
                }
            }),
        );

        // 手动刷新
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.refresh', () => {
                this.reactor.syncTelemetry();
                vscode.window.showInformationMessage(t('notify.refreshing'));
            }),
        );

        // 强制刷新模型缓存
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.refreshModelCache', async () => {
                try {
                    const models = await triggerService.refreshAvailableModelsCache();
                    vscode.window.showInformationMessage(`Model list cache refreshed (${models.length}).`);
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    vscode.window.showErrorMessage(`Failed to refresh model list cache: ${err.message}`);
                }
            }),
        );

        // 显示日志
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.showLogs', () => {
                logger.show();
            }),
        );

        // 重试连接
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.retry', async () => {
                await this.onRetry();
            }),
        );

        // 打开反馈页面
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.openFeedback', () => {
                vscode.env.openExternal(vscode.Uri.parse(FEEDBACK_URL));
            }),
        );

        // 设置警告阈值
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.setWarningThreshold', async () => {
                const config = configService.getConfig();
                const input = await vscode.window.showInputBox({
                    prompt: t('threshold.setWarning', { value: config.warningThreshold }),
                    placeHolder: t('threshold.inputWarning'),
                    value: String(config.warningThreshold),
                    validateInput: (value) => {
                        const num = parseInt(value, 10);
                        if (isNaN(num) || num < 5 || num > 80) {
                            return t('threshold.invalid', { min: 5, max: 80 });
                        }
                        if (num <= config.criticalThreshold) {
                            return `Warning threshold must be greater than critical threshold (${config.criticalThreshold}%)`;
                        }
                        return null;
                    },
                });
                if (input) {
                    const newValue = parseInt(input, 10);
                    await configService.updateConfig('warningThreshold', newValue);
                    vscode.window.showInformationMessage(t('threshold.updated', { value: newValue }));
                    this.reactor.reprocess();
                }
            }),
        );

        // 设置危险阈值
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.setCriticalThreshold', async () => {
                const config = configService.getConfig();
                const input = await vscode.window.showInputBox({
                    prompt: t('threshold.setCritical', { value: config.criticalThreshold }),
                    placeHolder: t('threshold.inputCritical'),
                    value: String(config.criticalThreshold),
                    validateInput: (value) => {
                        const num = parseInt(value, 10);
                        if (isNaN(num) || num < 1 || num > 50) {
                            return t('threshold.invalid', { min: 1, max: 50 });
                        }
                        if (num >= config.warningThreshold) {
                            return `Critical threshold must be less than warning threshold (${config.warningThreshold}%)`;
                        }
                        return null;
                    },
                });
                if (input) {
                    const newValue = parseInt(input, 10);
                    await configService.updateConfig('criticalThreshold', newValue);
                    vscode.window.showInformationMessage(t('threshold.updated', { value: newValue }));
                    this.reactor.reprocess();
                }
            }),
        );

        // 设置自动切换阈值
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.setAutoSwitchThreshold', async () => {
                const config = configService.getConfig();
                const input = await vscode.window.showInputBox({
                    prompt: t('threshold.setAutoSwitch', { value: config.autoSwitchThreshold }),
                    placeHolder: t('threshold.inputAutoSwitch'),
                    value: String(config.autoSwitchThreshold),
                    validateInput: (value) => {
                        const num = parseInt(value, 10);
                        if (isNaN(num) || num < 0 || num > 100) {
                            return t('threshold.invalid', { min: 0, max: 100 });
                        }
                        return null;
                    },
                });
                if (input) {
                    const newValue = parseInt(input, 10);
                    await configService.updateConfig('autoSwitchThreshold', newValue);
                    if (newValue <= 0) {
                        vscode.window.showInformationMessage(t('threshold.autoSwitchDisabled'));
                    } else {
                        vscode.window.showInformationMessage(t('threshold.autoSwitchUpdated', { value: newValue }));
                    }
                }
            }),
        );

        // 强制刷新公告
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.refreshAnnouncements', async () => {
                try {
                    const state = await announcementService.forceRefresh();
                    vscode.window.showInformationMessage(
                        t('announcement.refreshed').replace('{count}', String(state.announcements.length)),
                    );
                    // 更新 HUD 中的公告状态
                    this.hud.sendMessage({
                        type: 'announcementState',
                        data: state,
                    });
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    vscode.window.showErrorMessage(`Failed to refresh announcements: ${err.message}`);
                }
            }),
        );

    }
}
