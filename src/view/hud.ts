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
import { AccountsRefreshService } from '../services/accountsRefreshService';
import { cockpitToolsWs } from '../services/cockpitToolsWs';

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

    private refreshSubscription?: vscode.Disposable;

    constructor(
        extensionUri: vscode.Uri, 
        context: vscode.ExtensionContext,
        private readonly refreshService?: AccountsRefreshService,
    ) {
        this.extensionUri = extensionUri;
        this.context = context;

        if (this.refreshService) {
            this.refreshSubscription = this.refreshService.onDidUpdate(() => {
                this.syncAccountsToWebview();
            });
        }
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

                webviewPanel.onDidChangeViewState((e) => {
                    if (e.webviewPanel.visible) {
                        this.notifyPanelRevealed(e.webviewPanel);
                    }
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
                if (webviewPanel.visible) {
                    this.notifyPanelRevealed(webviewPanel, 250);
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
            const wasVisible = this.panel.visible;
            if (localeChanged) {
                this.panel.webview.html = this.generateHtml(this.panel.webview);
            }
            this.panel.reveal(column);
            await this.refreshWithCachedData();
            if (!wasVisible && this.panel.visible) {
                this.notifyPanelRevealed(this.panel, 120);
            }
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

            panel.onDidChangeViewState((e) => {
                if (e.webviewPanel.visible) {
                    this.notifyPanelRevealed(e.webviewPanel);
                }
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
            if (panel.visible) {
                this.notifyPanelRevealed(panel, 250);
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

    private notifyPanelRevealed(panel: vscode.WebviewPanel, delayMs = 120): void {
        setTimeout(() => {
            if (this.panel !== panel || !panel.visible) {
                return;
            }
            panel.webview.postMessage({ type: 'panelRevealed' });
        }, delayMs);
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
            antigravityToolsSyncEnabled: false,
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
        if (this.refreshSubscription) {
            this.refreshSubscription.dispose();
            this.refreshSubscription = undefined;
        }
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
     * 同步账号数据到 Webview
     */
    public syncAccountsToWebview(): void {
        if (!this.panel || !this.refreshService) {
            return;
        }

        const accounts = this.refreshService.getAccountsMap();
        const quotaCache = this.refreshService.getQuotaCacheMap();
        const accountsList = [];

        for (const [email, account] of accounts) {
            const cache = quotaCache.get(email);
            const hasCache = Boolean(cache);
            const loading = cache?.loading ?? !hasCache;
            const error = cache?.error;
            const lastUpdated = cache?.fetchedAt;
            const groups = cache ? this.convertGroups(cache.snapshot) : [];

            accountsList.push({
                email,
                isCurrent: account.isCurrent,
                hasDeviceBound: account.hasDeviceBound,
                tier: account.tier || '',
                loading,
                error,
                lastUpdated,
                groups,
            });
        }

        this.panel.webview.postMessage({
            type: 'accountsUpdate',
            data: {
                accounts: accountsList,
                config: configService.getConfig(),
                toolsConnected: cockpitToolsWs.isConnected,
            },
        });
    }

    /**
     * 转换配额分组数据 (复用于 Webview)
     */
    private convertGroups(snapshot: QuotaSnapshot): Array<{
        groupId: string;
        groupName: string;
        percentage: number;
        resetTime: string;
        resetTimeFormatted: string;
        models: Array<{
            label: string;
            modelId: string;
            percentage: number;
            resetTime: string;
            resetTimeFormatted: string;
        }>;
    }> {
        if (!snapshot.groups || snapshot.groups.length === 0) {
            return snapshot.models.map(model => ({
                groupId: model.modelId || model.label,
                groupName: model.label,
                percentage: model.remainingPercentage ?? 0,
                resetTime: model.resetTimeDisplay,
                resetTimeFormatted: model.timeUntilResetFormatted,
                models: [{
                    label: model.label,
                    modelId: model.modelId,
                    percentage: model.remainingPercentage ?? 0,
                    resetTime: model.resetTimeDisplay,
                    resetTimeFormatted: model.timeUntilResetFormatted,
                }],
            }));
        }

        return snapshot.groups.map(group => ({
            groupId: group.groupId,
            groupName: group.groupName,
            percentage: group.remainingPercentage ?? 0,
            resetTime: group.resetTimeDisplay,
            resetTimeFormatted: group.timeUntilResetFormatted,
            models: group.models.map(model => ({
                label: model.label,
                modelId: model.modelId,
                percentage: model.remainingPercentage ?? 0,
                resetTime: model.resetTimeDisplay,
                resetTimeFormatted: model.timeUntilResetFormatted,
            })),
        }));
    }

    /**
     * 获取账号总览国际化字符串
     */
    private getI18nStrings(): Record<string, string> {
        return {
            'title': t('accountsOverview.title') || 'Accounts Overview',
            'subtitle': t('accountsOverview.subtitle') || 'Real-time monitoring of all account quotas',
            'back': t('accountsOverview.back') || 'Back to Dashboard',
            'totalAccounts': t('accountsOverview.totalAccounts') || '{count} Accounts',
            'search': t('accountsOverview.search') || 'Search accounts...',
            'all': t('accountsOverview.all') || 'All',
            'sortBy': t('accountsOverview.sortBy') || 'Sort by',
            'sortOverall': t('accountsOverview.sortOverall') || 'Overall Quota',
            'sortByLastUpdated': t('accountsOverview.sortByLastUpdated') || 'By Update Time',
            'sortByGroup': t('accountsOverview.sortByGroup') || 'By {group} Quota',
            'sortByGroupReset': t('accountsOverview.sortByGroupReset') || 'By {group} Reset Time',
            'sortAsc': t('accountsOverview.sortAsc') || 'Ascending',
            'sortDesc': t('accountsOverview.sortDesc') || 'Descending',
            'sortLabel': t('accountsOverview.sortLabel') || 'Sort',
            'refreshAll': t('accountsOverview.refreshAll') || 'Refresh All',
            'addAccount': t('accountsOverview.addAccount') || 'Add Account',
            'export': t('accountsOverview.export') || 'Export',
            'current': t('accountsOverview.current') || 'Current',
            'loading': t('accountsOverview.loading') || 'Loading...',
            'error': t('accountsOverview.error') || 'Error',
            'refresh': t('accountsOverview.refresh') || 'Refresh',
            'switch': t('accountsOverview.switch') || 'Switch',
            'delete': t('accountsOverview.delete') || 'Delete',
            'updated': t('accountsOverview.updated') || 'Updated',
            'confirmDelete': t('accountsOverview.confirmDelete') || 'Confirm delete account?',
            'confirmDeleteBatch': t('accountsOverview.confirmDeleteBatch') || 'Confirm delete {count} selected accounts?',
            'deleteSelected': t('accountsOverview.deleteSelected') || 'Delete Selected',
            'selectAll': t('accountsOverview.selectAll') || 'Select All',
            'deselectAll': t('accountsOverview.deselectAll') || 'Deselect All',
            'noAccounts': t('accountsOverview.noAccounts') || 'No accounts found',
            'addFirstAccount': t('accountsOverview.addFirstAccount') || 'Add your first account to get started',
            'noMatchTitle': t('accountsOverview.noMatchTitle') || 'No matching accounts',
            'noMatchDesc': t('accountsOverview.noMatchDesc') || 'No accounts match the current filters',
            'switchConfirm': t('accountsOverview.switchConfirm') || 'Switch to this account?',
            'switchWarning': t('accountsOverview.switchWarning') || 'This will restart Antigravity client to complete the switch.',
            'confirm': t('common.confirm') || 'Confirm',
            'cancel': t('common.cancel') || 'Cancel',
            'close': t('common.close') || 'Close',
            'viewList': t('accountsOverview.viewList') || 'List',
            'viewGrid': t('accountsOverview.viewGrid') || 'Grid',
            'hideSensitive': t('profile.hideData') || '隐藏邮箱',
            'showSensitive': t('profile.showData') || '显示邮箱',
            'filterLabel': t('accountsOverview.filterLabel') || 'Filter',
            'filterAll': t('accountsOverview.filterAll') || 'All',
            'filterPro': t('accountsOverview.filterPro') || 'PRO',
            'filterUltra': t('accountsOverview.filterUltra') || 'ULTRA',
            'filterFree': t('accountsOverview.filterFree') || 'FREE',
            'columnEmail': t('accountsOverview.columnEmail') || 'Email',
            'columnQuota': t('accountsOverview.columnQuota') || 'Quota',
            'columnActions': t('accountsOverview.columnActions') || 'Actions',
            'quotaDetails': t('accountsOverview.quotaDetails') || 'Quota Details',
            'details': t('accountsOverview.details') || 'Details',
            'noQuotaData': t('accountsOverview.noQuotaData') || 'No quota data',
            // Add Account Modal
            'authorize': t('accountsOverview.authorize') || '授权',
            'import': t('accountsOverview.import') || '导入',
            'oauthHint': t('accountsOverview.oauthHint') || '推荐使用浏览器完成 Google 授权',
            'startOAuth': t('accountsOverview.startOAuth') || '开始 OAuth 授权',
            'oauthContinue': t('accountsOverview.oauthContinue') || '我已授权，继续',
            'oauthLinkLabel': t('accountsOverview.oauthLinkLabel') || '授权链接',
            'oauthGenerating': t('accountsOverview.oauthGenerating') || '正在生成链接...',
            'copy': t('common.copy') || '复制',
            'oauthStarting': t('accountsOverview.oauthStarting') || '授权中...',
            'oauthContinuing': t('accountsOverview.oauthContinuing') || '等待授权中...',
            'copySuccess': t('accountsOverview.copySuccess') || '已复制',
            'copyFailed': t('accountsOverview.copyFailed') || '复制失败',
            'tokenHint': t('accountsOverview.tokenHint') || '输入 Refresh Token 直接添加账号',
            'tokenPlaceholder': t('accountsOverview.tokenPlaceholder') || '粘贴 refresh_token 或 JSON 数组',
            'tokenImportStart': t('accountsOverview.tokenImportStart') || '开始导入',
            'tokenInvalid': t('accountsOverview.tokenInvalid') || 'refresh_token 无效',
            'tokenImportProgress': t('accountsOverview.tokenImportProgress') || '正在导入 {current}/{total}',
            'tokenImportSuccess': t('accountsOverview.tokenImportSuccess') || '导入成功',
            'tokenImportPartial': t('accountsOverview.tokenImportPartial') || '部分导入完成',
            'tokenImportFailed': t('accountsOverview.tokenImportFailed') || '导入失败',
            'email': t('accountsOverview.email') || '邮箱',
            'importHint': t('accountsOverview.importHint') || '从 JSON 文件或剪贴板导入账号',
            'content': t('accountsOverview.content') || '内容',
            'paste': t('accountsOverview.paste') || '粘贴',
            'importFromExtension': t('accountsOverview.importFromExtension') || '从插件导入',
            'importFromExtensionDesc': t('accountsOverview.importFromExtensionDesc') || '同步 Cockpit Tools 账号',
            'importFromLocal': t('accountsOverview.importFromLocal') || '从本地数据库导入',
            'importFromLocalDesc': t('accountsOverview.importFromLocalDesc') || '读取本机 Antigravity 登录账号',
            'importFromTools': t('accountsOverview.importFromTools') || '导入 Antigravity Tools',
            'importFromToolsDesc': t('accountsOverview.importFromToolsDesc') || '从 ~/.antigravity_tools/ 迁移历史账号',
            'importNoAccounts': t('accountsOverview.importNoAccounts') || '未找到可导入账号',
            'importSuccess': t('accountsOverview.importSuccess') || '导入成功',
            'importFailed': t('accountsOverview.importFailed') || '导入失败',
            'importLocalSuccess': t('accountsOverview.importLocalSuccess') || '导入完成',
            'importProgress': t('accountsOverview.importProgress') || '正在导入 {current}/{total}: {email}',
            'importingExtension': t('accountsOverview.importingExtension') || '导入中...',
            'importingLocal': t('accountsOverview.importingLocal') || '导入中...',
            'importingTools': t('accountsOverview.importingTools') || '导入中...',
            'settings': t('accountsOverview.settings') || '设置',
            'announcements': t('accountsOverview.announcements') || '公告',
            'noAnnouncements': t('accountsOverview.noAnnouncements') || '暂无公告',
            'autoRefresh': t('accountsOverview.autoRefresh') || '自动刷新',
            'autoRefreshDesc': t('accountsOverview.autoRefreshDesc') || '打开页面时自动刷新配额',
            'openDashboard': t('accountsOverview.openDashboard') || '打开配额监视器',
            'openDashboardDesc': t('accountsOverview.openDashboardDesc') || '返回配额监视器主界面',
            'go': t('accountsOverview.go') || '前往',
        };
    }

    /**
     * 生成 HTML 内容
     */
    private generateHtml(webview: vscode.Webview): string {
        // 获取外部资源 URI
        const styleUri = this.getWebviewUri(webview, 'out', 'view', 'webview', 'dashboard.css');
        const accountsOverviewStyleUri = this.getWebviewUri(webview, 'out', 'view', 'webview', 'accounts_overview.css');
        const sharedModalStyleUri = this.getWebviewUri(webview, 'out', 'view', 'webview', 'shared_modals.css');
        const autoTriggerStyleUri = this.getWebviewUri(webview, 'out', 'view', 'webview', 'auto_trigger.css');
        const scriptUri = this.getWebviewUri(webview, 'out', 'view', 'webview', 'dashboard.js');
        const autoTriggerScriptUri = this.getWebviewUri(webview, 'out', 'view', 'webview', 'auto_trigger.js');
        const authUiScriptUri = this.getWebviewUri(webview, 'out', 'view', 'webview', 'auth_ui.js');
        const accountsOverviewScriptUri = this.getWebviewUri(webview, 'out', 'view', 'webview', 'accounts_overview.js');

        // 获取国际化文本
        const translations = i18n.getAllTranslations();
        const translationsJson = JSON.stringify(translations);
        const accountsOverviewI18n = this.getI18nStrings();
        const accountsOverviewI18nJson = JSON.stringify(accountsOverviewI18n);

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
    <link rel="stylesheet" href="${accountsOverviewStyleUri}">
    <link rel="stylesheet" href="${sharedModalStyleUri}">
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
            <button id="toggle-profile-btn" class="refresh-btn" title="${t('profile.togglePlan')}">
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
        <button class="tab-btn" data-tab="accounts">👥 ${t('accountsOverview.title') || 'Accounts'}</button>
        <button class="tab-btn" data-tab="history">📈 ${t('history.tabTitle')}</button>
        <div id="quota-source-info" class="quota-source-info hidden"></div>
        <div class="tab-spacer"></div>
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

    <!-- Accounts Overview Tab Content -->
    <div id="tab-accounts" class="tab-content">
        <div class="accounts-overview-container">
            <main class="main-content accounts-page">
                <div class="toolbar">
                    <div class="toolbar-left">
                        <div class="search-box">
                            <span class="search-icon">🔍</span>
                            <input type="text" id="ao-search-input" placeholder="${t('accountsOverview.search')}" />
                        </div>

                        <div class="view-switcher">
                            <button id="ao-view-list" class="view-btn" title="${t('accountsOverview.viewList') || 'List'}">☰</button>
                            <button id="ao-view-grid" class="view-btn active" title="${t('accountsOverview.viewGrid') || 'Grid'}">▦</button>
                        </div>

                        <div class="filter-select">
                            <select id="ao-filter-select" aria-label="${t('accountsOverview.filterLabel') || 'Filter'}">
                                <option value="all">${t('accountsOverview.filterAll') || t('accountsOverview.all') || 'All'}</option>
                                <option value="PRO">PRO</option>
                                <option value="ULTRA">ULTRA</option>
                                <option value="FREE">FREE</option>
                            </select>
                        </div>

                        <div class="sort-container">
                            <div class="sort-select">
                                <span class="sort-icon">⇅</span>
                                <select id="ao-sort-select" aria-label="${t('accountsOverview.sortLabel') || 'Sort'}">
                                    <option value="overall">${t('accountsOverview.sortOverall')}</option>
                                </select>
                            </div>
                            <button id="ao-sort-direction-btn" class="sort-direction-btn" title="${t('accountsOverview.sortLabel')}">⬇</button>
                        </div>
                    </div>

                    <div class="toolbar-right">
                        <button id="ao-toggle-privacy-btn" class="btn btn-secondary" title="${t('profile.hideData') || '隐藏邮箱'}" aria-label="${t('profile.hideData') || '隐藏邮箱'}">
                            ${t('profile.hideData') || '隐藏邮箱'}
                        </button>
                        <button id="ao-add-btn" class="btn btn-primary" title="${t('accountsOverview.addAccount')}" aria-label="${t('accountsOverview.addAccount')}">
                            ${t('accountsOverview.addAccount')}
                        </button>
                        <button id="ao-refresh-all-btn" class="btn btn-secondary" title="${t('accountsOverview.refreshAll')}" aria-label="${t('accountsOverview.refreshAll')}">
                            ${t('accountsOverview.refreshAll')}
                        </button>
                        <button id="ao-import-btn" class="btn btn-secondary" title="${t('accountsOverview.import')}" aria-label="${t('accountsOverview.import')}">
                            ${t('accountsOverview.import')}
                        </button>
                        <button id="ao-export-btn" class="btn btn-secondary export-btn" title="${t('accountsOverview.export')}" aria-label="${t('accountsOverview.export')}">
                            ${t('accountsOverview.export')}
                        </button>
                        <button id="ao-delete-selected-btn" class="btn btn-danger icon-only hidden" title="${t('accountsOverview.delete') || 'Delete'}" aria-label="${t('accountsOverview.delete') || 'Delete'}">🗑</button>
                    </div>
                </div>

                <div id="ao-action-message" class="action-message hidden">
                    <span id="ao-action-message-text" class="action-message-text"></span>
                    <button id="ao-action-message-close" class="action-message-close" aria-label="${t('common.close')}">×</button>
                </div>

                <div id="ao-loading" class="empty-state hidden">
                    <div class="loading-spinner" style="width: 40px; height: 40px;"></div>
                </div>

                <div id="ao-empty-state" class="empty-state hidden">
                    <div class="icon">🚀</div>
                    <h3>${t('accountsOverview.noAccounts')}</h3>
                    <p>${t('accountsOverview.addFirstAccount')}</p>
                    <button id="ao-add-first-btn" class="btn btn-primary">＋ ${t('accountsOverview.addAccount')}</button>
                </div>

                <div id="ao-empty-match" class="empty-state hidden">
                    <h3>${t('accountsOverview.noMatchTitle')}</h3>
                    <p>${t('accountsOverview.noMatchDesc')}</p>
                </div>

                <div id="ao-accounts-grid" class="accounts-grid"></div>

                <div id="ao-accounts-table" class="account-table-container hidden">
                    <table class="account-table">
                        <thead>
                            <tr>
                                <th style="width: 40px;">
                                    <input type="checkbox" id="ao-select-all" />
                                </th>
                                <th style="width: 240px;">${t('accountsOverview.columnEmail')}</th>
                                <th>${t('accountsOverview.columnQuota')}</th>
                                <th class="sticky-action-header table-action-header">${t('accountsOverview.columnActions')}</th>
                            </tr>
                        </thead>
                        <tbody id="ao-accounts-tbody"></tbody>
                    </table>
                </div>
            </main>
        </div>
    </div>

    <!-- Modals -->

    <div id="ao-add-modal" class="modal-overlay hidden">
        <div class="modal-card modal-lg add-account-modal">
            <div class="modal-header">
                <h2>${t('accountsOverview.addAccount')}</h2>
                <button id="ao-add-close" class="close-btn" aria-label="${t('common.close') || 'Close'}">×</button>
            </div>
            <div class="modal-body">
                <div class="add-tabs">
                    <button class="add-tab active" data-tab="oauth">🌐 ${t('accountsOverview.authorize')}</button>
                    <button class="add-tab" data-tab="token">🔑 Refresh Token</button>
                    <button class="add-tab" data-tab="import">📋 ${t('accountsOverview.import')}</button>
                </div>

                <div class="add-panel" data-panel="oauth">
                    <div class="oauth-hint">
                        🌐 <span>${t('accountsOverview.oauthHint')}</span>
                    </div>
                    <div class="oauth-actions">
                        <button class="btn btn-primary" id="ao-oauth-start">🌐 ${t('accountsOverview.startOAuth')}</button>
                        <button class="btn btn-secondary" id="ao-oauth-continue">${t('accountsOverview.oauthContinue')}</button>
                    </div>
                    <div class="oauth-link">
                        <label>${t('accountsOverview.oauthLinkLabel')}</label>
                        <div class="oauth-link-row">
                            <input type="text" id="ao-oauth-link" value="${t('accountsOverview.oauthGenerating')}" readonly />
                            <button class="btn btn-secondary icon-only" id="ao-oauth-copy" title="${t('common.copy') || 'Copy'}">⧉</button>
                        </div>
                    </div>
                </div>

                <div class="add-panel hidden" data-panel="token">
                    <p class="add-panel-desc">${t('accountsOverview.tokenHint')}</p>
                    <textarea id="ao-token-input" class="token-input" rows="6" placeholder="${t('accountsOverview.tokenPlaceholder')}"></textarea>
                    <div class="modal-actions">
                        <button class="btn btn-primary" id="ao-token-import">🔑 ${t('accountsOverview.tokenImportStart')}</button>
                    </div>
                </div>

                <div class="add-panel hidden" data-panel="import">
                    <div class="import-options">
                        <button class="import-option" id="ao-import-local">
                            <div class="import-option-icon">🗄️</div>
                            <div class="import-option-content">
                                <div class="import-option-title">${t('accountsOverview.importFromLocal')}</div>
                                <div class="import-option-desc">${t('accountsOverview.importFromLocalDesc')}</div>
                            </div>
                        </button>
                        <button class="import-option" id="ao-import-tools">
                            <div class="import-option-icon">🚀</div>
                            <div class="import-option-content">
                                <div class="import-option-title">${t('accountsOverview.importFromTools')}</div>
                                <div class="import-option-desc">${t('accountsOverview.importFromToolsDesc')}</div>
                            </div>
                        </button>
                    </div>
                </div>

                <div id="ao-add-feedback" class="add-feedback hidden"></div>
            </div>
        </div>
    </div>

    <div id="ao-confirm-modal" class="modal-overlay hidden">
        <div class="modal-card">
            <div class="modal-header">
                <h2 id="ao-confirm-title">${t('common.confirm')}</h2>
                <button id="ao-confirm-close" class="close-btn" aria-label="${t('common.close') || 'Close'}">×</button>
            </div>
            <div class="modal-body">
                <p id="ao-confirm-message"></p>
            </div>
            <div class="modal-footer">
                <button id="ao-confirm-cancel" class="btn btn-secondary">${t('common.cancel')}</button>
                <button id="ao-confirm-ok" class="btn btn-primary">${t('common.confirm')}</button>
            </div>
        </div>
    </div>

    <div id="ao-quota-modal" class="modal-overlay hidden">
        <div class="modal-card modal-lg">
            <div class="modal-header">
                <h2>${t('accountsOverview.quotaDetails')}</h2>
                <div id="ao-quota-badges" class="badges"></div>
                <button id="ao-quota-close" class="close-btn" aria-label="${t('common.close') || 'Close'}">×</button>
            </div>
            <div class="modal-body">
                <div id="ao-quota-list" class="quota-list"></div>
                <div class="modal-actions">
                    <button id="ao-quota-close-btn" class="btn btn-secondary">${t('common.close')}</button>
                    <button id="ao-quota-refresh" class="btn btn-primary">${t('accountsOverview.refresh')}</button>
                </div>
            </div>
        </div>
    </div>

    <!-- History Tab Content -->
    <div id="tab-history" class="tab-content">
        <div class="history-card">
            <div class="history-header">
                <div class="history-title">📈 ${t('history.title')}</div>
                <div class="history-controls">
                    <label class="history-label" for="history-account-select">${t('history.accountLabel')}</label>
                    <select id="history-account-select" class="history-select"></select>
                    <label class="history-label" for="history-model-select">${t('history.modelLabel')}</label>
                    <select id="history-model-select" class="history-select"></select>
                    <div class="history-range">
                        <button class="history-range-btn" data-range="1">${t('history.range24h')}</button>
                        <button class="history-range-btn" data-range="7">${t('history.range7d')}</button>
                        <button class="history-range-btn" data-range="30">${t('history.range30d')}</button>
                        <button id="history-clear-btn" class="history-range-btn icon-only" title="${t('history.clearTooltip') || 'Clear History'}" style="margin-left: 8px;">🗑️</button>
                    </div>
                </div>
            </div>
            <div class="history-body">
                <canvas id="history-chart" class="history-canvas"></canvas>
                <div id="history-empty" class="history-empty hidden">${t('history.noData')}</div>
            </div>
            <div class="history-details">
                <div class="history-details-title">${t('history.tableTitle')}</div>
                <div class="history-table-wrapper">
                    <table class="history-table">
                        <thead>
                            <tr>
                                <th>${t('history.tableTime')}</th>
                                <th>${t('history.tablePercent')}</th>
                                <th>${t('history.tableDelta')}</th>
                                <th>${t('history.tableResetTime')}</th>
                                <th>${t('history.tableCountdown')}</th>
                            </tr>
                        </thead>
                        <tbody id="history-table-body"></tbody>
                    </table>
                    <div id="history-table-empty" class="history-table-empty hidden">${t('history.tableEmpty')}</div>
                </div>
                <div class="history-pagination">
                    <button id="history-prev" class="history-page-btn">${t('history.paginationPrev')}</button>
                    <span id="history-page-info" class="history-page-info"></span>
                    <button id="history-next" class="history-page-btn">${t('history.paginationNext')}</button>
                </div>
            </div>
            <div class="history-footer">
                <div id="history-metric-label" class="history-metric"></div>
                <div id="history-summary" class="history-summary"></div>
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

    <!-- History Clear Confirm Modal -->
    <div id="history-clear-modal" class="modal hidden">
        <div class="modal-content modal-content-small">
            <div class="modal-header">
                <h3>⚠️ ${t('history.clearTitle')}</h3>
                <button id="history-clear-close" class="close-btn">×</button>
            </div>
            <div class="modal-body" style="text-align: center; padding: 20px;">
                <p id="history-clear-message" style="margin-bottom: 20px;">${t('history.clearConfirmDefault') || 'Are you sure you want to clear quota history?'}</p>
            </div>
            <div class="modal-footer" style="flex-direction: column; gap: 8px;">
                <button id="history-clear-this-btn" class="btn-primary" style="background: var(--vscode-errorForeground); width: 100%;">🗑️ ${t('history.clearThis') || 'Clear This Account'}</button>
                <button id="history-clear-all-btn" class="btn-secondary" style="width: 100%; color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground);">🗑️ ${t('history.clearAll') || 'Clear All Accounts'}</button>
                <button id="history-clear-cancel" class="btn-secondary" style="width: 100%; margin-top: 4px;">${t('common.cancel')}</button>
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
                    ${i18n.t('footer.star')}
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
        window.__accountsOverviewI18n = ${accountsOverviewI18nJson};
    </script>
    <script nonce="${nonce}" src="${authUiScriptUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
    <script nonce="${nonce}" src="${autoTriggerScriptUri}"></script>
    <script nonce="${nonce}" src="${accountsOverviewScriptUri}"></script>
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
