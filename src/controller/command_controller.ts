
import * as vscode from 'vscode';
import { CockpitHUD } from '../view/hud';
import { QuickPickView } from '../view/quickpick_view';
import { ReactorCore } from '../engine/reactor';
import { configService } from '../shared/config_service';
import { logger } from '../shared/log_service';
import { t } from '../shared/i18n';
import { DISPLAY_MODE, FEEDBACK_URL } from '../shared/constants';

export class CommandController {
    constructor(
        private context: vscode.ExtensionContext,
        private hud: CockpitHUD,
        private quickPickView: QuickPickView,
        private reactor: ReactorCore,
        private onRetry: () => Promise<void>
    ) {
        this.registerCommands();
    }

    private registerCommands(): void {
        // 打开 Dashboard
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.open', async () => {
                const config = configService.getConfig();
                if (config.displayMode === DISPLAY_MODE.QUICKPICK) {
                    this.quickPickView.show();
                } else {
                    const success = await this.hud.revealHud();
                    if (!success) {
                        // Webview 创建失败，引导用户切换到 QuickPick 模式
                        const selection = await vscode.window.showWarningMessage(
                            t('webview.failedPrompt'),
                            t('webview.switchToQuickPick'),
                            t('webview.cancel'),
                        );
                        if (selection === t('webview.switchToQuickPick')) {
                            await configService.updateConfig('displayMode', DISPLAY_MODE.QUICKPICK);
                            // 同时关闭分组模式，因为 QuickPick 不支持分组
                            if (config.groupingEnabled) {
                                await configService.updateConfig('groupingEnabled', false);
                            }
                            vscode.window.showInformationMessage(t('webview.switchedToQuickPick'));
                            // 刷新状态栏以反映分组模式关闭
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
    }
}
