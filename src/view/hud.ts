/**
 * Antigravity Cockpit - HUD 视图
 * 负责创建和管理 Webview Dashboard
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { QuotaSnapshot, DashboardConfig, WebviewMessage } from '../shared/types';
import { logger } from '../shared/log_service';
import { configService } from '../shared/config_service';
import { i18n, t } from '../shared/i18n';

/**
 * CockpitHUD 类
 * 管理 Webview 面板的创建、更新和销毁
 */
export class CockpitHUD {
    public static readonly viewType = 'antigravity.cockpit';
    
    private panels: Map<string, vscode.WebviewPanel> = new Map();
    private cachedTelemetry?: QuotaSnapshot;
    private messageRouter?: (message: WebviewMessage) => void;
    private readonly extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
    }

    /**
     * 显示 HUD 面板
     */
    public revealHud(snapshot?: QuotaSnapshot): void {
        if (snapshot) {
            this.cachedTelemetry = snapshot;
        }

        const column = vscode.window.activeTextEditor?.viewColumn;
        const existingPanel = this.panels.get('main');

        if (existingPanel) {
            existingPanel.reveal(column);
            this.refreshWithCachedData();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            CockpitHUD.viewType,
            t('dashboard.title'),
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [this.extensionUri],
                retainContextWhenHidden: true,
            },
        );

        this.panels.set('main', panel);

        panel.onDidDispose(() => {
            this.panels.delete('main');
        });

        panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
            if (this.messageRouter) {
                this.messageRouter(message);
            }
        });

        panel.webview.html = this.generateHtml(panel.webview);

        if (this.cachedTelemetry) {
            this.refreshWithCachedData();
        }
    }

    /**
     * 使用缓存数据刷新视图
     */
    private refreshWithCachedData(): void {
        if (this.cachedTelemetry) {
            const config = configService.getConfig();
            this.refreshView(this.cachedTelemetry, {
                showPromptCredits: config.showPromptCredits,
                pinnedModels: config.pinnedModels,
                modelOrder: config.modelOrder,
                groupingEnabled: config.groupingEnabled,
                groupCustomNames: config.groupingCustomNames,
                groupingShowInStatusBar: config.groupingShowInStatusBar,
                pinnedGroups: config.pinnedGroups,
                groupOrder: config.groupOrder,
                refreshInterval: config.refreshInterval,
                notificationEnabled: config.notificationEnabled,
                warningThreshold: config.warningThreshold,
                criticalThreshold: config.criticalThreshold,
            });
        }
    }

    /**
     * 从缓存恢复数据
     */
    public rehydrate(): void {
        this.refreshWithCachedData();
    }

    /**
     * 注册消息处理器
     */
    public onSignal(handler: (message: WebviewMessage) => void): void {
        this.messageRouter = handler;
    }

    /**
     * 刷新视图
     */
    public refreshView(snapshot: QuotaSnapshot, config: DashboardConfig): void {
        this.cachedTelemetry = snapshot;
        const panel = this.panels.get('main');
        
        if (panel?.visible) {
            // 转换数据为 Webview 兼容格式
            const webviewData = this.convertToWebviewFormat(snapshot);
            
            panel.webview.postMessage({
                type: 'telemetry_update',
                data: webviewData,
                config: config,
            });
        }
    }

    /**
     * 转换数据格式（驼峰转下划线，兼容 Webview JS）
     */
    private convertToWebviewFormat(snapshot: QuotaSnapshot): object {
        return {
            timestamp: snapshot.timestamp,
            isConnected: snapshot.isConnected,
            errorMessage: snapshot.errorMessage,
            prompt_credits: snapshot.promptCredits ? {
                available: snapshot.promptCredits.available,
                monthly: snapshot.promptCredits.monthly,
                remainingPercentage: snapshot.promptCredits.remainingPercentage,
                usedPercentage: snapshot.promptCredits.usedPercentage,
            } : undefined,
            userInfo: snapshot.userInfo ? {
                name: snapshot.userInfo.name,
                email: snapshot.userInfo.email,
                planName: snapshot.userInfo.planName,
                tier: snapshot.userInfo.tier,
                browserEnabled: snapshot.userInfo.browserEnabled,
                knowledgeBaseEnabled: snapshot.userInfo.knowledgeBaseEnabled,
                canBuyMoreCredits: snapshot.userInfo.canBuyMoreCredits,
                hasAutocompleteFastMode: snapshot.userInfo.hasAutocompleteFastMode,
                monthlyPromptCredits: snapshot.userInfo.monthlyPromptCredits,
                monthlyFlowCredits: snapshot.userInfo.monthlyFlowCredits,
                availablePromptCredits: snapshot.userInfo.availablePromptCredits,
                availableFlowCredits: snapshot.userInfo.availableFlowCredits,
                cascadeWebSearchEnabled: snapshot.userInfo.cascadeWebSearchEnabled,
                canGenerateCommitMessages: snapshot.userInfo.canGenerateCommitMessages,
                allowMcpServers: snapshot.userInfo.allowMcpServers,
                maxNumChatInputTokens: snapshot.userInfo.maxNumChatInputTokens,
                tierDescription: snapshot.userInfo.tierDescription,
                upgradeUri: snapshot.userInfo.upgradeUri,
                upgradeText: snapshot.userInfo.upgradeText,
                // New fields
                teamsTier: snapshot.userInfo.teamsTier,
                hasTabToJump: snapshot.userInfo.hasTabToJump,
                allowStickyPremiumModels: snapshot.userInfo.allowStickyPremiumModels,
                allowPremiumCommandModels: snapshot.userInfo.allowPremiumCommandModels,
                maxNumPremiumChatMessages: snapshot.userInfo.maxNumPremiumChatMessages,
                maxCustomChatInstructionCharacters: snapshot.userInfo.maxCustomChatInstructionCharacters,
                maxNumPinnedContextItems: snapshot.userInfo.maxNumPinnedContextItems,
                maxLocalIndexSize: snapshot.userInfo.maxLocalIndexSize,
                monthlyFlexCreditPurchaseAmount: snapshot.userInfo.monthlyFlexCreditPurchaseAmount,
                canCustomizeAppIcon: snapshot.userInfo.canCustomizeAppIcon,
                cascadeCanAutoRunCommands: snapshot.userInfo.cascadeCanAutoRunCommands,
                canAllowCascadeInBackground: snapshot.userInfo.canAllowCascadeInBackground,
                allowAutoRunCommands: snapshot.userInfo.allowAutoRunCommands,
                allowBrowserExperimentalFeatures: snapshot.userInfo.allowBrowserExperimentalFeatures,
                acceptedLatestTermsOfService: snapshot.userInfo.acceptedLatestTermsOfService,
                userTierId: snapshot.userInfo.userTierId,
            } : undefined,
            models: snapshot.models.map(m => ({
                label: m.label,
                modelId: m.modelId,
                remainingPercentage: m.remainingPercentage,
                isExhausted: m.isExhausted,
                timeUntilResetFormatted: m.timeUntilResetFormatted,
                resetTimeDisplay: m.resetTimeDisplay,
            })),
            groups: snapshot.groups?.map(g => ({
                groupId: g.groupId,
                groupName: g.groupName,
                remainingPercentage: g.remainingPercentage,
                resetTimeDisplay: g.resetTimeDisplay,
                timeUntilResetFormatted: g.timeUntilResetFormatted,
                isExhausted: g.isExhausted,
                models: g.models.map(m => ({
                    label: m.label,
                    modelId: m.modelId,
                })),
            })),
        };
    }

    /**
     * 销毁所有面板
     */
    public dispose(): void {
        this.panels.forEach(panel => panel.dispose());
        this.panels.clear();
    }

    /**
     * 获取 Webview 资源 URI
     */
    private getWebviewUri(webview: vscode.Webview, ...pathSegments: string[]): vscode.Uri {
        return webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, ...pathSegments),
        );
    }

    /**
     * 读取外部资源文件内容
     */
    private readResourceFile(...pathSegments: string[]): string {
        try {
            const filePath = path.join(this.extensionUri.fsPath, ...pathSegments);
            return fs.readFileSync(filePath, 'utf8');
        } catch (e) {
            logger.error(`Failed to read resource file: ${pathSegments.join('/')}`, e);
            return '';
        }
    }

    /**
     * 生成 HTML 内容
     */
    private generateHtml(webview: vscode.Webview): string {
        // 获取外部资源 URI
        const styleUri = this.getWebviewUri(webview, 'src', 'view', 'webview', 'dashboard.css');
        const scriptUri = this.getWebviewUri(webview, 'src', 'view', 'webview', 'dashboard.js');

        // 获取国际化文本
        const translations = i18n.getAllTranslations();
        const translationsJson = JSON.stringify(translations);

        // CSP nonce
        const nonce = this.generateNonce();

        return `<!DOCTYPE html>
<html lang="${i18n.getLocale()}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>${t('dashboard.title')}</title>
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <header class="header">
        <div class="header-title">
            <span class="icon">🚀</span>
            <span>${t('dashboard.title')}</span>
        </div>
        <div class="controls">
            <button id="refresh-btn" class="refresh-btn" title="Manual Refresh (60s Cooldown)">
                ${t('dashboard.refresh')}
            </button>
            <button id="reset-order-btn" class="refresh-btn" title="Reset to default order">
                ${t('dashboard.resetOrder')}
            </button>
            <button id="toggle-grouping-btn" class="refresh-btn" title="${t('grouping.toggleHint')}">
                ${t('grouping.title')}
            </button>
            <button id="toggle-profile-btn" class="refresh-btn" title="${t('profile.togglePlan')}">
                ${t('profile.planDetails')}
            </button>
            <button id="settings-btn" class="refresh-btn icon-only" title="${t('threshold.settings')}">
                ⚙️
            </button>
        </div>
    </header>

    <div id="last-update-bar" class="last-update-bar hidden">
        <span id="last-update-text"></span>
    </div>

    <div id="status" class="status-connecting">
        <span class="spinner"></span>
        <span>${t('dashboard.connecting')}</span>
    </div>

    <div id="dashboard">
        <!-- Injected via JS -->
    </div>

    <div id="settings-modal" class="modal hidden">
        <div class="modal-content">
            <div class="modal-header">
                <h3>⚙️ ${t('threshold.settings')}</h3>
                <button id="close-settings-btn" class="close-btn">×</button>
            </div>
            <div class="modal-body">
                <div class="setting-item">
                    <label for="notification-enabled" class="checkbox-label">
                        <input type="checkbox" id="notification-enabled" checked>
                        <span>🔔 ${t('threshold.enableNotification')}</span>
                    </label>
                    <p class="setting-hint">${t('threshold.enableNotificationHint')}</p>
                </div>
                <div class="setting-item">
                    <label for="warning-threshold">🟡 ${t('threshold.warning')}</label>
                    <div class="setting-input-group">
                        <input type="number" id="warning-threshold" min="5" max="80" value="30">
                        <span class="unit">%</span>
                        <span class="range-hint">(5-80)</span>
                    </div>
                    <p class="setting-hint">${t('threshold.warningHint')}</p>
                </div>
                <div class="setting-item">
                    <label for="critical-threshold">🔴 ${t('threshold.critical')}</label>
                    <div class="setting-input-group">
                        <input type="number" id="critical-threshold" min="1" max="50" value="10">
                        <span class="unit">%</span>
                        <span class="range-hint">(1-50)</span>
                    </div>
                    <p class="setting-hint">${t('threshold.criticalHint')}</p>
                </div>
                <p class="setting-note">💡 ${i18n.getLocale() === 'zh-cn' ? '超出范围的值会自动调整' : 'Out-of-range values will be auto-adjusted'}</p>
            </div>
            <div class="modal-footer">
                <button id="save-settings-btn" class="btn-primary">${i18n.getLocale() === 'zh-cn' ? '保存' : 'Save'}</button>
            </div>
        </div>
    </div>

    <div id="toast" class="toast hidden"></div>

    <footer class="dashboard-footer">
        <div class="footer-content">
            <span class="footer-text">${i18n.getLocale() === 'zh-cn' ? '觉得好用？给个 ⭐ 支持一下！' : 'Enjoying this? Give us a ⭐!'}</span>
            <div class="footer-links">
                <a href="https://github.com/jlcodes99/vscode-antigravity-cockpit" target="_blank" class="footer-link star-link">
                    ⭐ Star
                </a>
                <a href="https://github.com/jlcodes99/vscode-antigravity-cockpit/issues" target="_blank" class="footer-link feedback-link">
                    💬 ${i18n.getLocale() === 'zh-cn' ? '反馈' : 'Feedback'}
                </a>
            </div>
        </div>
    </footer>

    <script nonce="${nonce}">
        // 注入国际化文本
        window.__i18n = ${translationsJson};
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    /**
     * 生成随机 nonce
     */
    private generateNonce(): string {
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let nonce = '';
        for (let i = 0; i < 32; i++) {
            nonce += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return nonce;
    }
}

// 保持向后兼容的导出别名
export { CockpitHUD as hud };
