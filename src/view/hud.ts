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
import { i18n, t, localeDisplayNames } from '../shared/i18n';
import { credentialStorage } from '../auto_trigger';

/**
 * CockpitHUD 类
 * 管理 Webview 面板的创建、更新和销毁
 */
export class CockpitHUD {
    public static readonly viewType = 'antigravity.cockpit';
    
    private panel: vscode.WebviewPanel | undefined;
    private cachedTelemetry?: QuotaSnapshot;
    private messageRouter?: (message: WebviewMessage) => void;
    private readonly extensionUri: vscode.Uri;
    private readonly context: vscode.ExtensionContext;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this.extensionUri = extensionUri;
        this.context = context;
    }

    /**
     * 注册 Webview Panel Serializer
     * 用于在插件重载后恢复 panel 引用
     */
    public registerSerializer(): vscode.Disposable {
        return vscode.window.registerWebviewPanelSerializer(CockpitHUD.viewType, {
            deserializeWebviewPanel: async (webviewPanel: vscode.WebviewPanel, _state: unknown) => {
                logger.info('[CockpitHUD] Restoring webview panel after reload');
                
                // 如果已经有一个 panel，关闭旧的
                if (this.panel) {
                    logger.info('[CockpitHUD] Disposing old panel before restoration');
                    this.panel.dispose();
                }
                
                // 恢复引用
                this.panel = webviewPanel;

                // 重新设置 webview 内容和事件监听
                webviewPanel.webview.options = {
                    enableScripts: true,
                    localResourceRoots: [this.extensionUri],
                };

                // 重新同步语言（确保跟随 VS Code 语言时生效）
                i18n.applyLanguageSetting(configService.getConfig().language);
                webviewPanel.webview.html = this.generateHtml(webviewPanel.webview);
                
                webviewPanel.onDidDispose(() => {
                    this.panel = undefined;
                });
                
                webviewPanel.webview.onDidReceiveMessage((message: WebviewMessage) => {
                    if (this.messageRouter) {
                        this.messageRouter(message);
                    }
                });
                
                // 恢复后刷新数据
                if (this.cachedTelemetry) {
                    await this.refreshWithCachedData();
                }
            },
        });
    }

    /**
     * 显示 HUD 面板
     * @param initialTab 可选的初始标签页 (如 'auto-trigger')
     * @returns 是否成功打开
     */
    public async revealHud(initialTab?: string): Promise<boolean> {
        const localeChanged = i18n.applyLanguageSetting(configService.getConfig().language);
        const column = vscode.window.activeTextEditor?.viewColumn;

        // 如果已经有 panel，直接显示
        if (this.panel) {
            if (localeChanged) {
                this.panel.webview.html = this.generateHtml(this.panel.webview);
            }
            this.panel.reveal(column);
            await this.refreshWithCachedData();
            // 如果指定了初始标签页，发送消息切换
            if (initialTab) {
                setTimeout(() => {
                    this.panel?.webview.postMessage({ type: 'switchTab', tab: initialTab });
                }, 100);
            }
            return true;
        }

        // 在创建新 panel 之前，先关闭所有旧版本的同类型 webview tabs
        // 这解决了插件升级后出现多个 panel 的问题（旧版本没有 serializer）
        await this.closeOrphanTabs();

        try {
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

            this.panel = panel;

            panel.onDidDispose(() => {
                this.panel = undefined;
            });

            panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
                if (this.messageRouter) {
                    this.messageRouter(message);
                }
            });

            panel.webview.html = this.generateHtml(panel.webview);

            if (this.cachedTelemetry) {
                await this.refreshWithCachedData();
            }

            // 如果指定了初始标签页，延迟发送消息切换
            if (initialTab) {
                setTimeout(() => {
                    panel.webview.postMessage({ type: 'switchTab', tab: initialTab });
                }, 500);
            }

            return true;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`Failed to create Webview panel: ${err.message}`);
            return false;
        }
    }

    /**
     * 关闭所有孤儿 webview tabs（旧版本遗留的 panel）
     * 使用 tabGroups API 遍历所有打开的 tabs
     */
    private async closeOrphanTabs(): Promise<void> {
        try {
            const tabsToClose: vscode.Tab[] = [];
            
            for (const tabGroup of vscode.window.tabGroups.all) {
                for (const tab of tabGroup.tabs) {
                    // 检查是否是 webview tab
                    if (tab.input instanceof vscode.TabInputWebview) {
                        const tabViewType = tab.input.viewType;
                        // viewType 可能带有 extension id 前缀，使用 includes 匹配
                        if (tabViewType === CockpitHUD.viewType || 
                            tabViewType.includes(CockpitHUD.viewType) ||
                            tabViewType.endsWith(CockpitHUD.viewType)) {
                            tabsToClose.push(tab);
                        }
                    }
                }
            }

            if (tabsToClose.length > 0) {
                logger.info(`[CockpitHUD] Closing ${tabsToClose.length} orphan webview tab(s)`);
                await vscode.window.tabGroups.close(tabsToClose);
            }
        } catch (error) {
            // tabGroups API 可能在某些环境不可用，静默忽略
        }
    }

    /**
     * 使用缓存数据刷新视图
     */
    private async refreshWithCachedData(): Promise<void> {
        if (!this.cachedTelemetry) {
            return;
        }
        const config = configService.getConfig();
        const authorizationStatus = await credentialStorage.getAuthorizationStatus();
        const authorizedAvailable = authorizationStatus.isAuthorized;

        this.refreshView(this.cachedTelemetry, {
            showPromptCredits: config.showPromptCredits,
            pinnedModels: config.pinnedModels,
            modelOrder: config.modelOrder,
            modelCustomNames: config.modelCustomNames,
            visibleModels: config.visibleModels,
            groupingEnabled: config.groupingEnabled,
            groupCustomNames: config.groupingCustomNames,
            groupingShowInStatusBar: config.groupingShowInStatusBar,
            pinnedGroups: config.pinnedGroups,
            groupOrder: config.groupOrder,
            refreshInterval: config.refreshInterval,
            notificationEnabled: config.notificationEnabled,
            warningThreshold: config.warningThreshold,
            criticalThreshold: config.criticalThreshold,
            statusBarFormat: config.statusBarFormat,
            profileHidden: config.profileHidden,
            quotaSource: config.quotaSource,
            authorizedAvailable,
            authorizationStatus,
            displayMode: config.displayMode,
            dataMasked: config.dataMasked,
            groupMappings: config.groupMappings,
            language: config.language,
            antigravityToolsSyncEnabled: configService.getStateFlag('antigravityToolsSyncEnabled', false),
            antigravityToolsAutoSwitchEnabled: configService.getStateFlag('antigravityToolsAutoSwitchEnabled', true),
        });
    }

    /**
     * 从缓存恢复数据
     */
    public async rehydrate(): Promise<void> {
        await this.refreshWithCachedData();
    }

    /**
     * 注册消息处理器
     */
    public onSignal(handler: (message: WebviewMessage) => void): void {
        this.messageRouter = handler;
    }

    /**
     * 向 Webview 发送消息
     */
    public sendMessage(message: object): void {
        if (this.panel) {
            this.panel.webview.postMessage(message);
        }
    }

    /**
     * 检查 Webview 面板是否可见（用户当前正在查看）
     */
    public isVisible(): boolean {
        return this.panel?.visible === true;
    }

    /**
     * 刷新视图
     */
    public refreshView(snapshot: QuotaSnapshot, config: DashboardConfig): void {
        this.cachedTelemetry = snapshot;
        
        if (this.panel) {
            const localeChanged = i18n.applyLanguageSetting(configService.getConfig().language);
            if (localeChanged) {
                this.panel.webview.html = this.generateHtml(this.panel.webview);
            }

            // 转换数据为 Webview 兼容格式
            const webviewData = this.convertToWebviewFormat(snapshot);

            this.panel.webview.postMessage({
                type: 'telemetry_update',
                data: webviewData,
                config,
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
                // 模型能力字段
                supportsImages: m.supportsImages,
                isRecommended: m.isRecommended,
                tagTitle: m.tagTitle,
                supportedMimeTypes: m.supportedMimeTypes,
            })),
            allModels: snapshot.allModels?.map(m => ({
                label: m.label,
                modelId: m.modelId,
                remainingPercentage: m.remainingPercentage,
                isExhausted: m.isExhausted,
                timeUntilResetFormatted: m.timeUntilResetFormatted,
                resetTimeDisplay: m.resetTimeDisplay,
                supportsImages: m.supportsImages,
                isRecommended: m.isRecommended,
                tagTitle: m.tagTitle,
                supportedMimeTypes: m.supportedMimeTypes,
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
                    // 模型能力字段
                    supportsImages: m.supportsImages,
                    isRecommended: m.isRecommended,
                    tagTitle: m.tagTitle,
                    supportedMimeTypes: m.supportedMimeTypes,
                })),
            })),
            // 本地账户邮箱（local 模式下使用远端 API 时）
            localAccountEmail: snapshot.localAccountEmail,
        };
    }

    /**
     * 销毁面板
     */
    public dispose(): void {
        if (this.panel) {
            this.panel.dispose();
            this.panel = undefined;
        }
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
        const styleUri = this.getWebviewUri(webview, 'out', 'view', 'webview', 'dashboard.css');
        const autoTriggerStyleUri = this.getWebviewUri(webview, 'out', 'view', 'webview', 'auto_trigger.css');
        const scriptUri = this.getWebviewUri(webview, 'out', 'view', 'webview', 'dashboard.js');
        const autoTriggerScriptUri = this.getWebviewUri(webview, 'out', 'view', 'webview', 'auto_trigger.js');
        const authUiScriptUri = this.getWebviewUri(webview, 'out', 'view', 'webview', 'auth_ui.js');

        // 获取国际化文本
        const translations = i18n.getAllTranslations();
        const translationsJson = JSON.stringify(translations);

        const timeOptions = [
            '06:00',
            '07:00',
            '08:00',
            '09:00',
            '10:00',
            '11:00',
            '12:00',
            '14:00',
            '16:00',
            '18:00',
            '20:00',
            '22:00',
        ];
        const renderTimeChips = (options: string[], selected: string): string => {
            return options.map(time => {
                const selectedClass = time === selected ? ' selected' : '';
                return `<div class="at-chip${selectedClass}" data-time="${time}">${time}</div>`;
            }).join('');
        };

        // CSP nonce
        const nonce = this.generateNonce();

        return `<!DOCTYPE html>
<html lang="${i18n.getLocale()}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src https: data:;">
    <title>${t('dashboard.title')}</title>
    <link rel="stylesheet" href="${styleUri}">
    <link rel="stylesheet" href="${autoTriggerStyleUri}">
</head>
<body>
    <header class="header">
        <div class="header-title">
            <span class="icon">🚀</span>
            <span>${t('dashboard.title')}</span>
        </div>
        <div class="controls">
            <button id="refresh-btn" class="refresh-btn" title="${t('statusBarFormat.manualRefresh')}">
                ${t('dashboard.refresh')}
            </button>
            <button id="reset-order-btn" class="refresh-btn" title="${t('statusBarFormat.resetOrderTooltip')}">
                ${t('dashboard.resetOrder')}
            </button>
            <button id="manage-models-btn" class="refresh-btn" title="${t('models.manageTitle')}">
                ${t('models.manage')}
            </button>
            <button id="toggle-grouping-btn" class="refresh-btn" title="${t('grouping.toggleHint')}">
                ${t('grouping.title')}
            </button>
            <!-- 计划按钮已隐藏 -->
            <button id="toggle-profile-btn" class="refresh-btn hidden" title="${t('profile.togglePlan')}">
                ${t('profile.planDetails')}
            </button>
            <button id="announcement-btn" class="refresh-btn icon-only" title="${t('announcement.title')}">
                🔔<span id="announcement-badge" class="notification-badge hidden">0</span>
            </button>
            <button id="settings-btn" class="refresh-btn icon-only" title="${t('threshold.settings')}">
                ⚙️
            </button>
        </div>
    </header>

    <!-- Tab Navigation -->
    <nav class="tab-nav">
        <button class="tab-btn active" data-tab="quota">📊 ${t('dashboard.title')}</button>
        <button class="tab-btn" data-tab="auto-trigger">
            ${t('autoTrigger.tabTitle')} <span id="at-tab-status-dot" class="status-dot hidden">●</span>
        </button>
        <div id="quota-source-info" class="quota-source-info hidden"></div>
        <div class="tab-spacer"></div>
        <div class="quota-source-toggle">
            <span class="quota-source-label">${t('quotaSource.title')}</span>
            <div class="quota-source-buttons">
                <button type="button" class="quota-source-btn" data-source="local">${t('quotaSource.local')}</button>
                <button type="button" class="quota-source-btn" data-source="authorized">${t('quotaSource.authorized')}</button>
            </div>
            <span class="quota-source-status" data-state="ok" title="${t('quotaSource.title')}"></span>
        </div>
    </nav>

    <!-- Quota Tab Content -->
    <div id="tab-quota" class="tab-content active">
        <div id="status" class="status-connecting">
            <span class="spinner"></span>
            <span>${t('dashboard.connecting')}</span>
        </div>

        <div id="quota-auth-card" class="quota-auth-card hidden">
            <div id="quota-auth-row" class="quota-auth-row"></div>
        </div>

        <div id="dashboard">
            <!-- Injected via JS -->
        </div>
    </div>

    <!-- Auto Trigger Tab Content -->
    <div id="tab-auto-trigger" class="tab-content">
        <div class="auto-trigger-compact">
            <!-- Description Card -->
            <div class="at-description-card">
                <div class="at-desc-title">${t('autoTrigger.descriptionTitle')}</div>
                <div class="at-desc-content">${t('autoTrigger.description')}</div>
            </div>

            <!-- Auth Row -->
            <div class="quota-auth-card">
                <div class="quota-auth-row" id="at-auth-row"></div>
            </div>

            <!-- Status Overview Card -->
            <div class="at-status-card" id="at-status-card">
                <!-- Status Grid (hidden when unauthorized) -->
                <div class="at-status-grid" id="at-status-grid">
                    <div class="at-status-item">
                        <span class="at-label">⏰ ${t('autoTrigger.statusLabel')}</span>
                        <span class="at-value" id="at-status-value">${t('autoTrigger.disabled')}</span>
                    </div>
                    <div class="at-status-item">
                        <span class="at-label">📅 ${t('autoTrigger.modeLabel')}</span>
                        <span class="at-value" id="at-mode-value">--</span>
                    </div>
                    <div class="at-status-item">
                        <span class="at-label">🤖 ${t('autoTrigger.modelsLabel')}</span>
                        <span class="at-value" id="at-models-value">--</span>
                    </div>
                    <div class="at-status-item">
                        <span class="at-label">👤 ${t('autoTrigger.accountsLabel')}</span>
                        <span class="at-value" id="at-accounts-value">--</span>
                    </div>
                    <div class="at-status-item">
                        <span class="at-label">⏭️ ${t('autoTrigger.nextTrigger')}</span>
                        <span class="at-value" id="at-next-value">--</span>
                    </div>
                </div>

                <!-- Action Buttons -->
                <div class="at-actions" id="at-actions">
                    <button id="at-config-btn" class="at-btn at-btn-secondary">
                        ⚙️ ${t('autoTrigger.configBtn')}
                    </button>
                    <button id="at-test-btn" class="at-btn at-btn-accent">
                        ${t('autoTrigger.testBtn')}
                    </button>
                    <button id="at-history-btn" class="at-btn at-btn-secondary">
                        📜 ${t('autoTrigger.historyBtn')} <span id="at-history-count">(0)</span>
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- Config Modal -->
    <div id="at-config-modal" class="modal hidden">
        <div class="modal-content modal-content-medium">
            <div class="modal-header">
                <h3>${t('autoTrigger.scheduleSection')}</h3>
                <button id="at-config-close" class="close-btn">×</button>
            </div>
            <div class="modal-body at-config-body">
                <!-- Enable Wake-up Toggle -->
                <div class="at-config-row">
                    <label>${t('autoTrigger.enableAutoWakeup')}</label>
                    <label class="toggle-switch">
                        <input type="checkbox" id="at-enable-schedule">
                        <span class="toggle-slider"></span>
                    </label>
                </div>

                <div id="at-wakeup-config-body">
                    <!-- Custom Prompt (shared by all modes) -->
                    <div class="at-config-section at-custom-prompt-outer" id="at-custom-prompt-section">
                        <label>${t('autoTrigger.customPrompt')}</label>
                        <input type="text" id="at-custom-prompt" placeholder="${t('autoTrigger.customPromptPlaceholder')}" class="at-input" maxlength="100">
                        <p class="at-hint">${t('autoTrigger.customPromptHint')}</p>
                    </div>

                    <div class="at-config-section">
                        <label>${t('autoTrigger.maxOutputTokensLabel')}</label>
                        <input type="number" id="at-max-output-tokens" min="1" class="at-input-small">
                        <p class="at-hint">${t('autoTrigger.maxOutputTokensHint')}</p>
                    </div>

                    <!-- Trigger Mode Selection -->
                    <div class="at-config-section at-trigger-mode-section">
                        <label>${t('autoTrigger.triggerMode')}</label>
                        <p class="at-hint">${t('autoTrigger.triggerModeHint')}</p>
                        <div id="at-trigger-mode-list" class="at-segmented">
                            <button type="button" class="at-segment-btn" data-mode="scheduled">📅 ${t('autoTrigger.modeScheduled')}</button>
                            <button type="button" class="at-segment-btn" data-mode="crontab">🧩 ${t('autoTrigger.modeCrontab')}</button>
                            <button type="button" class="at-segment-btn" data-mode="quota_reset">🔄 ${t('autoTrigger.modeQuotaReset')}</button>
                        </div>
                    </div>

                    <!-- Model Selection (shared by all modes) -->
                    <div class="at-config-section">
                        <label>${t('autoTrigger.modelSection')}</label>
                        <p class="at-hint">${t('autoTrigger.modelsHint')}</p>
                        <div id="at-config-models" class="at-model-list">
                            <div class="at-loading">${t('dashboard.connecting')}</div>
                        </div>
                    </div>

                    <!-- Account Selection (shared by all modes) -->
                    <div class="at-config-section">
                        <label>${t('autoTrigger.accountSection')}</label>
                        <p class="at-hint">${t('autoTrigger.accountHint')}</p>
                        <div id="at-config-accounts" class="at-model-list">
                            <div class="at-loading">${t('dashboard.connecting')}</div>
                        </div>
                    </div>

                    <!-- Scheduled Config -->
                    <div id="at-schedule-config-section">
                        <div class="at-config-section">
                            <label>${t('autoTrigger.repeatMode')}</label>
                            <select id="at-mode-select" class="at-select">
                                <option value="daily">${t('autoTrigger.daily')}</option>
                                <option value="weekly">${t('autoTrigger.weekly')}</option>
                                <option value="interval">${t('autoTrigger.interval')}</option>
                            </select>
                        </div>

                        <div id="at-config-daily" class="at-mode-config">
                            <label>${t('autoTrigger.selectTime')}</label>
                            <div class="at-time-grid" id="at-daily-times">
                                ${renderTimeChips(timeOptions, '08:00')}
                            </div>
                            <div class="at-custom-time-row">
                                <span class="at-custom-time-label">${t('autoTrigger.customTime')}</span>
                                <input type="time" id="at-daily-custom-time" class="at-input-time at-input-time-compact">
                                <button id="at-daily-add-time" class="at-btn at-btn-secondary at-btn-small">${t('autoTrigger.addTime')}</button>
                            </div>
                        </div>

                        <div id="at-config-weekly" class="at-mode-config hidden">
                            <label>${t('autoTrigger.selectDay')}</label>
                            <div class="at-day-grid" id="at-weekly-days">
                                <div class="at-chip selected" data-day="1">${t('common.weekday.mon.short')}</div>
                                <div class="at-chip selected" data-day="2">${t('common.weekday.tue.short')}</div>
                                <div class="at-chip selected" data-day="3">${t('common.weekday.wed.short')}</div>
                                <div class="at-chip selected" data-day="4">${t('common.weekday.thu.short')}</div>
                                <div class="at-chip selected" data-day="5">${t('common.weekday.fri.short')}</div>
                                <div class="at-chip" data-day="6">${t('common.weekday.sat.short')}</div>
                                <div class="at-chip" data-day="0">${t('common.weekday.sun.short')}</div>
                            </div>
                            <div class="at-quick-btns">
                                <button class="at-quick-btn" data-preset="workdays">${t('autoTrigger.workdays')}</button>
                                <button class="at-quick-btn" data-preset="weekend">${t('autoTrigger.weekend')}</button>
                                <button class="at-quick-btn" data-preset="all">${t('autoTrigger.allDays')}</button>
                            </div>
                            <label>${t('autoTrigger.selectTime')}</label>
                            <div class="at-time-grid" id="at-weekly-times">
                                ${renderTimeChips(timeOptions, '08:00')}
                            </div>
                            <div class="at-custom-time-row">
                                <span class="at-custom-time-label">${t('autoTrigger.customTime')}</span>
                                <input type="time" id="at-weekly-custom-time" class="at-input-time at-input-time-compact">
                                <button id="at-weekly-add-time" class="at-btn at-btn-secondary at-btn-small">${t('autoTrigger.addTime')}</button>
                            </div>
                        </div>

                        <div id="at-config-interval" class="at-mode-config hidden">
                            <div class="at-interval-row">
                                <label>${t('autoTrigger.intervalLabel')}</label>
                                <input type="number" id="at-interval-hours" min="1" max="12" value="4" class="at-input-small">
                                <span>${t('autoTrigger.hours')}</span>
                            </div>
                            <div class="at-interval-row">
                                <label>${t('autoTrigger.from')}</label>
                                <input type="time" id="at-interval-start" value="07:00" class="at-input-time">
                                <label>${t('autoTrigger.to')}</label>
                                <input type="time" id="at-interval-end" value="22:00" class="at-input-time">
                            </div>
                        </div>

                        <div class="at-preview">
                            <label>${t('autoTrigger.preview')}</label>
                            <ul id="at-next-runs-scheduled" class="at-preview-list">
                                <li>${t('autoTrigger.selectTimeHint')}</li>
                            </ul>
                        </div>
                    </div>

                    <!-- Crontab Config -->
                    <div id="at-crontab-config-section" class="hidden">
                        <div class="at-config-section">
                            <label>${t('autoTrigger.crontabLabel')}</label>
                            <div class="at-crontab-row">
                                <input type="text" id="at-crontab-input" placeholder="${t('autoTrigger.crontabPlaceholder')}" class="at-input">
                                <button id="at-crontab-validate" class="at-btn at-btn-small">${t('autoTrigger.validate')}</button>
                            </div>
                            <div id="at-crontab-result" class="at-crontab-result"></div>
                        </div>
                        <div class="at-preview">
                            <label>${t('autoTrigger.preview')}</label>
                            <ul id="at-next-runs-crontab" class="at-preview-list">
                                <li>${t('autoTrigger.selectTimeHint')}</li>
                            </ul>
                        </div>
                    </div>

                    <!-- Quota Reset Time Window Config -->
                    <div id="at-quota-reset-config-section" class="hidden">
                        <div class="at-config-section">
                            <div class="at-config-row">
                                <label>${t('autoTrigger.timeWindowEnabled')}</label>
                                <label class="toggle-switch">
                                    <input type="checkbox" id="at-time-window-enabled">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                            <p class="at-hint">${t('autoTrigger.timeWindowHint')}</p>
                        </div>

                        <div id="at-time-window-config" class="at-config-section hidden">
                            <label>${t('autoTrigger.timeWindowRange')}</label>
                            <p class="at-hint">${t('autoTrigger.timeWindowRangeHint')}</p>
                            <div class="at-interval-row">
                                <label>${t('autoTrigger.from')}</label>
                                <input type="time" id="at-time-window-start" value="09:00" class="at-input-time">
                                <label>${t('autoTrigger.to')}</label>
                                <input type="time" id="at-time-window-end" value="18:00" class="at-input-time">
                            </div>

                            <div class="at-config-section" style="margin-top: 16px;">
                                <label>${t('autoTrigger.fallbackTimes')}</label>
                                <p class="at-hint">${t('autoTrigger.fallbackTimesHint')}</p>
                                <div class="at-time-grid" id="at-fallback-times">
                                    <div class="at-chip" data-time="06:00">06:00</div>
                                    <div class="at-chip selected" data-time="07:00">07:00</div>
                                    <div class="at-chip" data-time="08:00">08:00</div>
                                </div>
                                <div class="at-custom-time-row">
                                    <span class="at-custom-time-label">${t('autoTrigger.customTime')}</span>
                                    <input type="time" id="at-fallback-custom-time" class="at-input-time at-input-time-compact">
                                    <button id="at-fallback-add-time" class="at-btn at-btn-secondary at-btn-small">${t('autoTrigger.addTime')}</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button id="at-config-cancel" class="btn-secondary">${t('common.cancel')}</button>
                <button id="at-config-save" class="btn-primary">💾 ${t('autoTrigger.saveBtn')}</button>
            </div>
        </div>
    </div>

    <!-- Test Modal -->
    <div id="at-test-modal" class="modal hidden">
        <div class="modal-content modal-content-small">
            <div class="modal-header">
                <h3>${t('autoTrigger.testBtn')}</h3>
                <button id="at-test-close" class="close-btn">×</button>
            </div>
            <div class="modal-body at-test-body">
                <label>${t('autoTrigger.selectModels')}</label>
                <div id="at-test-models" class="at-model-list">
                    <div class="at-loading">${t('dashboard.connecting')}</div>
                </div>

                <label>${t('autoTrigger.testAccountSection')}</label>
                <p class="at-hint">${t('autoTrigger.testAccountHint')}</p>
                <div id="at-test-accounts" class="at-model-list">
                    <div class="at-loading">${t('dashboard.connecting')}</div>
                </div>
                
                <!-- Custom Prompt for Test -->
                <div class="at-config-section at-test-prompt-section">
                    <label>${t('autoTrigger.customPrompt')}</label>
                    <input type="text" id="at-test-custom-prompt" placeholder="${t('autoTrigger.customPromptPlaceholder')}" class="at-input" maxlength="100">
                </div>
                <div class="at-config-section at-test-prompt-section">
                    <label>${t('autoTrigger.maxOutputTokensLabel')}</label>
                    <input type="number" id="at-test-max-output-tokens" min="1" class="at-input-small">
                    <p class="at-hint">${t('autoTrigger.maxOutputTokensHint')}</p>
                </div>
            </div>
            <div class="modal-footer">
                <button id="at-test-cancel" class="btn-secondary">${t('common.cancel')}</button>
                <button id="at-test-run" class="btn-primary">🚀 ${t('autoTrigger.triggerBtn')}</button>
            </div>
        </div>
    </div>

    <!-- History Modal -->
    <div id="at-history-modal" class="modal hidden">
        <div class="modal-content modal-content-medium">
            <div class="modal-header">
                <h3>${t('autoTrigger.historySection')}</h3>
                <button id="at-history-close" class="close-btn">×</button>
            </div>
            <div class="modal-body at-history-body">
                <div id="at-history-list" class="at-history-list">
                    <div class="at-no-data">${t('autoTrigger.noHistory')}</div>
                </div>
            </div>
            <div class="modal-footer">
                <button id="at-history-clear" class="btn-secondary" style="color: var(--vscode-errorForeground);">🗑️ ${t('autoTrigger.clearHistory')}</button>
            </div>
        </div>
    </div>

    <!-- Revoke Confirm Modal -->
    <div id="at-revoke-modal" class="modal hidden">
        <div class="modal-content modal-content-small">
            <div class="modal-header">
                <h3>⚠️ ${t('autoTrigger.revokeConfirmTitle')}</h3>
                <button id="at-revoke-close" class="close-btn">×</button>
            </div>
            <div class="modal-body" style="text-align: center; padding: 20px;">
                <p style="margin-bottom: 20px;">${t('autoTrigger.revokeConfirm')}</p>
            </div>
            <div class="modal-footer">
                <button id="at-revoke-cancel" class="btn-secondary">${t('common.cancel')}</button>
                <button id="at-revoke-confirm" class="btn-primary" style="background: var(--vscode-errorForeground);">🗑️ ${t('autoTrigger.confirmRevoke')}</button>
            </div>
        </div>
    </div>



    <!-- Model Manager Modal -->
    <div id="model-manager-modal" class="modal hidden">
        <div class="modal-content modal-content-wide">
            <div class="modal-header">
                <h3>🧩 ${t('models.manageTitle')}</h3>
                <button id="model-manager-close" class="close-btn">×</button>
            </div>
            <div class="modal-body model-manager-body">
                <div class="model-manager-hint">${t('models.hint')}</div>
                <div class="model-manager-toolbar">
                    <button id="model-manager-select-all" class="btn-secondary">${t('models.selectAll')}</button>
                    <button id="model-manager-clear" class="btn-secondary">${t('models.clearAll')}</button>
                    <button id="model-manager-select-recommended" class="btn-secondary hidden">${t('models.selectRecommended')}</button>
                    <span id="model-manager-count" class="model-manager-count"></span>
                </div>
                <div id="model-manager-list" class="model-manager-list"></div>
            </div>
            <div class="modal-footer">
                <button id="model-manager-cancel" class="btn-secondary">${t('common.cancel')}</button>
                <button id="model-manager-save" class="btn-primary">${t('models.save')}</button>
            </div>
        </div>
    </div>

    <div id="settings-modal" class="modal hidden">
        <div class="modal-content modal-content-wide">
            <div class="modal-header">
                <h3>⚙️ ${t('threshold.settings')}</h3>
                <button id="close-settings-btn" class="close-btn">×</button>
            </div>
            <div class="modal-body">
                <!-- 语言设置 -->
                <div class="setting-item">
                    <label for="language-select">🌐 ${t('language.title') || 'Language'}</label>
                    <select id="language-select" class="setting-select">
                        <option value="auto">${t('language.auto') || 'Auto (Follow VS Code)'}</option>
                        ${this.generateLanguageOptions()}
                    </select>
                    <p class="setting-hint">${t('language.hint') || 'Override VS Code language for this extension'}</p>
                </div>

                <hr class="setting-divider">

                <!-- Display Mode and View Mode moved to bottom -->

                <!-- 状态栏样式选择 -->
                <div class="setting-item">
                    <label for="statusbar-format">📊 ${i18n.t('statusBarFormat.title')}</label>
                    <select id="statusbar-format" class="setting-select">
                        <option value="icon">${i18n.t('statusBarFormat.iconDesc')} - ${i18n.t('statusBarFormat.icon')}</option>
                        <option value="dot">${i18n.t('statusBarFormat.dotDesc')} - ${i18n.t('statusBarFormat.dot')}</option>
                        <option value="percent">${i18n.t('statusBarFormat.percentDesc')} - ${i18n.t('statusBarFormat.percent')}</option>
                        <option value="compact">${i18n.t('statusBarFormat.compactDesc')} - ${i18n.t('statusBarFormat.compact')}</option>
                        <option value="namePercent">${i18n.t('statusBarFormat.namePercentDesc')} - ${i18n.t('statusBarFormat.namePercent')}</option>
                        <option value="standard" selected>${i18n.t('statusBarFormat.standardDesc')} - ${i18n.t('statusBarFormat.standard')}</option>
                    </select>
                </div>
                
                <hr class="setting-divider">
                
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

                <hr class="setting-divider">

                <!-- 显示模式切换 -->
                <div class="setting-item">
                    <label for="display-mode-select">🖥️ ${t('displayMode.title') || 'Display Mode'}</label>
                    <select id="display-mode-select" class="setting-select">
                        <option value="webview">🎨 ${t('displayMode.webview') || 'Dashboard'}</option>
                        <option value="quickpick">⚡ ${t('displayMode.quickpick') || 'QuickPick'}</option>
                    </select>
                </div>
            </div>
        </div>
    </div>

    <div id="rename-modal" class="modal hidden">
        <div class="modal-content">
            <div class="modal-header">
                <h3>✏️ ${i18n.t('model.renameTitle')}</h3>
                <button id="close-rename-btn" class="close-btn">×</button>
            </div>
            <div class="modal-body">
                <div class="setting-item">
                    <label for="rename-input">${i18n.t('model.newName')}</label>
                    <div class="setting-input-group">
                        <input type="text" id="rename-input" placeholder="${i18n.t('model.namePlaceholder')}" maxlength="30">
                    </div>
                </div>
            </div>
            <div class="modal-footer modal-footer-space-between">
                <button id="reset-name-btn" class="btn-secondary">${i18n.t('model.reset')}</button>
                <button id="save-rename-btn" class="btn-primary">${i18n.t('model.ok')}</button>
            </div>
        </div>
    </div>

    <div id="custom-grouping-modal" class="modal hidden">
        <div class="modal-content modal-content-large">
            <div class="modal-header">
                <h3>⚙️ ${i18n.t('customGrouping.title')}</h3>
                <button id="close-custom-grouping-btn" class="close-btn">×</button>
            </div>
            <div class="modal-body custom-grouping-body">
                <div class="custom-grouping-hint">
                    💡 ${i18n.t('customGrouping.hint')}
                </div>
                <div class="custom-grouping-toolbar">
                    <button id="smart-group-btn" class="btn-accent">
                        <span class="icon">🪄</span>
                        ${i18n.t('customGrouping.smartGroup')}
                    </button>
                    <button id="add-group-btn" class="btn-secondary">
                        <span class="icon">➕</span>
                        ${i18n.t('customGrouping.addGroup')}
                    </button>
                </div>
                <div class="custom-grouping-content">
                    <div class="custom-groups-section">
                        <h4>📦 ${i18n.t('customGrouping.groupList')}</h4>
                        <div id="custom-groups-list" class="custom-groups-list">
                            <!-- Groups will be rendered here -->
                        </div>
                    </div>
                    <div class="ungrouped-section">
                        <h4>🎲 ${i18n.t('customGrouping.ungrouped')}</h4>
                        <p class="ungrouped-hint">${i18n.t('customGrouping.ungroupedHint')}</p>
                        <div id="ungrouped-models-list" class="ungrouped-models-list">
                            <!-- Ungrouped models will be rendered here -->
                        </div>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button id="cancel-custom-grouping-btn" class="btn-secondary">${i18n.t('customGrouping.cancel')}</button>
                <button id="save-custom-grouping-btn" class="btn-primary">💾 ${i18n.t('customGrouping.save')}</button>
            </div>
        </div>
    </div>

    <!-- Announcement List Modal -->
    <div id="announcement-list-modal" class="modal hidden">
        <div class="modal-content modal-content-medium">
            <div class="modal-header">
                <h3>🔔 ${t('announcement.title')}</h3>
                <button id="announcement-list-close" class="close-btn">×</button>
            </div>
            <div class="modal-body announcement-list-body">
                <div class="announcement-toolbar">
                    <button id="announcement-mark-all-read" class="btn-secondary btn-small">${t('announcement.markAllRead')}</button>
                </div>
                <div id="announcement-list" class="announcement-list">
                    <div class="announcement-empty">${t('announcement.empty')}</div>
                </div>
            </div>
        </div>
    </div>

    <!-- Announcement Popup Modal -->
    <div id="announcement-popup-modal" class="modal hidden">
        <div class="modal-content modal-content-medium announcement-popup-content">
            <div class="modal-header notification-header">
                <button id="announcement-popup-back" class="icon-btn back-btn hidden">←</button>
                <div class="announcement-header-title">
                    <span id="announcement-popup-type" class="announcement-type-badge"></span>
                    <h3 id="announcement-popup-title"></h3>
                </div>
                <button id="announcement-popup-close" class="close-btn">×</button>
            </div>
            <div class="modal-body announcement-popup-body">
                <div id="announcement-popup-content" class="announcement-content"></div>
            </div>
            <div class="modal-footer">
                <button id="announcement-popup-later" class="btn-secondary">${t('announcement.later')}</button>
                <button id="announcement-popup-action" class="btn-primary hidden"></button>
                <button id="announcement-popup-got-it" class="btn-primary">${t('announcement.gotIt')}</button>
            </div>
        </div>
    </div>

    <div id="toast" class="toast hidden"></div>

    <footer class="dashboard-footer">
        <div class="footer-content">
            <span class="footer-text">${i18n.t('footer.enjoyingThis')}</span>
            <div class="footer-links">
                <a href="https://github.com/jlcodes99/vscode-antigravity-cockpit" target="_blank" class="footer-link star-link">
                    ⭐ Star
                </a>
                <a href="https://github.com/jlcodes99/vscode-antigravity-cockpit/issues" target="_blank" class="footer-link feedback-link">
                    💬 ${i18n.t('footer.feedback')}
                </a>
                <a href="https://github.com/jlcodes99/vscode-antigravity-cockpit/blob/master/docs/DONATE.md" target="_blank" class="footer-link donate-link">
                    ☕ ${i18n.t('footer.donate') || 'Donate'}
                </a>
            </div>
        </div>
    </footer>

    <script nonce="${nonce}">
        // 注入国际化文本
        window.__i18n = ${translationsJson};
        window.__autoTriggerI18n = ${translationsJson};
    </script>
    <script nonce="${nonce}" src="${authUiScriptUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
    <script nonce="${nonce}" src="${autoTriggerScriptUri}"></script>
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

    /**
     * 生成语言选项 HTML
     */
    private generateLanguageOptions(): string {
        const locales = i18n.getSupportedLocales();
        return locales.map(locale => {
            const displayName = localeDisplayNames[locale] || locale;
            return `<option value="${locale}">${displayName}</option>`;
        }).join('\n                        ');
    }
}

// 保持向后兼容的导出别名
export { CockpitHUD as hud };
