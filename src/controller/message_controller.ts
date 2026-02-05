
import * as vscode from 'vscode';
import { CockpitHUD } from '../view/hud';
import { ReactorCore } from '../engine/reactor';
import { configService } from '../shared/config_service';
import { logger } from '../shared/log_service';
import { t, i18n, normalizeLocaleInput } from '../shared/i18n';
import { WebviewMessage } from '../shared/types';
import { TIMING } from '../shared/constants';
import { autoTriggerController } from '../auto_trigger/controller';
import { credentialStorage } from '../auto_trigger';
import { previewLocalCredential, commitLocalCredential } from '../auto_trigger/local_auth_importer';
import { announcementService } from '../announcement';
import { antigravityToolsSyncService } from '../antigravityTools_sync';
import { cockpitToolsWs, AccountInfo } from '../services/cockpitToolsWs';
import { getQuotaHistory, clearHistory, clearAllHistory } from '../services/quota_history';
import { oauthService } from '../auto_trigger';
import { AccountsRefreshService } from '../services/accountsRefreshService';

export class MessageController {
    // 跟踪已通知的模型以避免重复弹窗 (虽然主要逻辑在 TelemetryController，但 CheckAndNotify 可能被消息触发吗? 不, 主要是 handleMessage)
    // 这里主要是处理前端发来的指令
    private context: vscode.ExtensionContext;
    
    // 导入取消令牌
    private importCancelToken: { cancelled: boolean } | null = null;

    constructor(
        context: vscode.ExtensionContext,
        private hud: CockpitHUD,
        private reactor: ReactorCore,
        private onRetry: () => Promise<void>,
        private refreshService?: AccountsRefreshService,
    ) {
        this.context = context;
        this.setupMessageHandling();
    }

    private async applyQuotaSourceChange(
        source: 'local' | 'authorized',
    ): Promise<void> {
        const previousSource = configService.getConfig().quotaSource;

        if (source === 'authorized') {
            this.reactor.cancelInitRetry();
        }

        logger.info(`User changed quota source: ${previousSource} -> ${source}`);
        await configService.updateConfig('quotaSource', source);
        // 验证保存是否成功
        const savedSource = configService.getConfig().quotaSource;
        logger.info(`QuotaSource saved: requested=${source}, actual=${savedSource}`);

        // 发送 loading 状态提示
        this.hud.sendMessage({
            type: 'quotaSourceLoading',
            data: { source },
        });
        this.hud.sendMessage({
            type: 'switchTab',
            tab: 'quota',
        });

        // 如果配额来源发生变化，触发完整初始化流程
        if (previousSource !== source) {
            if (source === 'local') {
                await this.onRetry();
            } else {
                this.reactor.syncTelemetry();
            }
            return;
        }

        const cacheAge = this.reactor.getCacheAgeMs(source);
        const refreshIntervalMs = configService.getConfig().refreshInterval ?? TIMING.DEFAULT_REFRESH_INTERVAL_MS;
        const hasCache = this.reactor.publishCachedTelemetry(source);
        const cacheStale = cacheAge === undefined || cacheAge > refreshIntervalMs;
        if (!hasCache || cacheStale) {
            this.reactor.syncTelemetry();
        }
    }

    private setupMessageHandling(): void {
        // 设置 autoTriggerController 的消息处理器，使其能够推送状态更新到 webview
        autoTriggerController.setMessageHandler((message) => {
            if (message.type === 'auto_trigger_state_update') {
                this.hud.sendMessage({
                    type: 'autoTriggerState',
                    data: message.data,
                });
            }
        });

        this.hud.onSignal(async (msg: WebviewMessage) => {
            const message = msg;
            switch (message.command) {
                case 'togglePin':
                    logger.info(`Received togglePin signal: ${JSON.stringify(message)}`);
                    if (message.modelId) {
                        await configService.togglePinnedModel(message.modelId);
                        this.reactor.reprocess();
                    } else {
                        logger.warn('togglePin signal missing modelId');
                    }
                    break;

                case 'toggleCredits':
                    logger.info('User toggled Prompt Credits display');
                    await configService.toggleShowPromptCredits();
                    this.reactor.reprocess();
                    break;

                case 'updateOrder':
                    if (message.order) {
                        logger.info(`User updated model order. Count: ${message.order.length}`);
                        await configService.updateModelOrder(message.order);
                        this.reactor.reprocess();
                    } else {
                        logger.warn('updateOrder signal missing order data');
                    }
                    break;

                case 'updateVisibleModels':
                    if (Array.isArray(message.visibleModels)) {
                        logger.info(`User updated visible models. Count: ${message.visibleModels.length}`);
                        await configService.updateVisibleModels(message.visibleModels);
                        if (configService.getConfig().quotaSource === 'authorized') {
                            await configService.setStateFlag('visibleModelsInitializedAuthorized', true);
                        }
                        this.reactor.reprocess();
                    } else {
                        logger.warn('updateVisibleModels signal missing visibleModels');
                    }
                    break;

                case 'resetOrder': {
                    const currentConfig = configService.getConfig();
                    if (currentConfig.groupingEnabled) {
                        logger.info('User reset group order to default');
                        await configService.resetGroupOrder();
                    } else {
                        logger.info('User reset model order to default');
                        await configService.resetModelOrder();
                    }
                    this.reactor.reprocess();
                    break;
                }

                case 'refresh':
                    logger.info('User triggered manual refresh');
                    // 尝试确保 WebSocket 连接（如果断开则触发重连）
                    cockpitToolsWs.ensureConnected();

                    {
                        const config = configService.getConfig();
                        let handled = false;

                        if (config.quotaSource === 'authorized' && this.refreshService) {
                            const activeEmail = await credentialStorage.getActiveAccount();
                            if (activeEmail) {
                                logger.info(`[MsgCtrl] Refreshing active account: ${activeEmail}`);
                                // loadAccountQuota 内部使用 QuotaRefreshManager 并强制刷新 (forceRefresh=true)
                                await this.refreshService.loadAccountQuota(activeEmail);
                                handled = true;
                            }
                        }

                        if (!handled) {
                            // Local 模式或无活动账号，回落到原有逻辑
                            this.reactor.syncTelemetry();
                            if (this.refreshService) {
                                this.refreshService.refresh();
                            }
                        }

                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                    }
                    break;

                case 'init':
                    if (this.reactor.hasCache) {
                        logger.info('Dashboard initialized (reprocessing cached data)');
                        this.reactor.reprocess();
                    } else {
                        logger.info('Dashboard initialized (no cache, performing full sync)');
                        this.reactor.syncTelemetry();
                    }
                    if (this.refreshService) {
                        // 启动时刷新由扩展入口统一调度，避免早于 WS 连接
                    }
                    // 发送公告状态
                    {
                        const annState = await announcementService.getState();
                        this.hud.sendMessage({
                            type: 'announcementState',
                            data: annState,
                        });
                    }

                    break;

                case 'retry':
                    logger.info('User triggered connection retry');
                    await this.onRetry();
                    break;

                case 'openLogs':
                    logger.info('User opened logs');
                    logger.show();
                    break;

                case 'rerender':
                    logger.info('Dashboard requested re-render');
                    this.reactor.reprocess();
                    break;

                case 'toggleGrouping': {
                    logger.info('User toggled grouping display');
                    const enabled = await configService.toggleGroupingEnabled();
                    // 用户期望：切换到分组模式时，状态栏默认也显示分组
                    if (enabled) {
                        const config = configService.getConfig();
                        if (!config.groupingShowInStatusBar) {
                            await configService.updateConfig('groupingShowInStatusBar', true);
                        }

                        // 首次开启分组时（groupMappings 为空），自动执行分组
                        if (Object.keys(config.groupMappings).length === 0) {
                            const latestSnapshot = this.reactor.getLatestSnapshot();
                            if (latestSnapshot && latestSnapshot.models.length > 0) {
                                const newMappings = ReactorCore.calculateGroupMappings(latestSnapshot.models);
                                await configService.updateGroupMappings(newMappings);
                                logger.info(`First-time grouping: auto-grouped ${Object.keys(newMappings).length} models`);
                            }
                        }
                    }
                    // 使用缓存数据重新渲染
                    this.reactor.reprocess();
                    break;
                }

                case 'renameGroup':
                    if (message.modelIds && message.groupName) {
                        logger.info(`User renamed group to: ${message.groupName}`);
                        await configService.updateGroupName(message.modelIds, message.groupName);
                        // 使用缓存数据重新渲染
                        this.reactor.reprocess();
                    } else {
                        logger.warn('renameGroup signal missing required data');
                    }
                    break;

                case 'promptRenameGroup':
                    if (message.modelIds && message.currentName) {
                        const newName = await vscode.window.showInputBox({
                            prompt: t('grouping.renamePrompt'),
                            value: message.currentName,
                            placeHolder: t('grouping.rename'),
                        });
                        if (newName && newName.trim() && newName !== message.currentName) {
                            logger.info(`User renamed group to: ${newName}`);
                            await configService.updateGroupName(message.modelIds, newName.trim());
                            this.reactor.reprocess();
                        }
                    } else {
                        logger.warn('promptRenameGroup signal missing required data');
                    }
                    break;

                case 'toggleGroupPin':
                    if (message.groupId) {
                        logger.info(`Toggling group pin: ${message.groupId}`);
                        await configService.togglePinnedGroup(message.groupId);
                        this.reactor.reprocess();
                    } else {
                        logger.warn('toggleGroupPin signal missing groupId');
                    }
                    break;

                case 'updateGroupOrder':
                    if (message.order) {
                        logger.info(`User updated group order. Count: ${message.order.length}`);
                        await configService.updateGroupOrder(message.order);
                        this.reactor.reprocess();
                    } else {
                        logger.warn('updateGroupOrder signal missing order data');
                    }
                    break;

                case 'autoGroup': {
                    logger.info('User triggered auto-grouping');
                    // 获取最新的快照数据
                    const latestSnapshot = this.reactor.getLatestSnapshot();
                    if (latestSnapshot && latestSnapshot.models.length > 0) {
                        // 计算新的分组映射
                        const newMappings = ReactorCore.calculateGroupMappings(latestSnapshot.models);
                        await configService.updateGroupMappings(newMappings);
                        logger.info(`Auto-grouped ${Object.keys(newMappings).length} models`);

                        // 清除之前的 pinnedGroups（因为 groupId 已变化）
                        await configService.updateConfig('pinnedGroups', []);

                        // 重新处理数据以刷新 UI
                        this.reactor.reprocess();
                    } else {
                        logger.warn('No snapshot data available for auto-grouping');
                    }
                    break;
                }

                case 'updateNotificationEnabled':
                    // 处理通知开关变更
                    if (message.notificationEnabled !== undefined) {
                        const enabled = message.notificationEnabled as boolean;
                        await configService.updateConfig('notificationEnabled', enabled);
                        logger.info(`Notification enabled: ${enabled}`);
                        vscode.window.showInformationMessage(
                            enabled ? t('notification.enabled') : t('notification.disabled'),
                        );
                    }
                    break;

                case 'updateThresholds':
                    // 处理阈值更新
                    if (message.warningThreshold !== undefined && message.criticalThreshold !== undefined) {
                        const warningVal = message.warningThreshold as number;
                        const criticalVal = message.criticalThreshold as number;

                        if (criticalVal < warningVal && warningVal >= 5 && warningVal <= 80 && criticalVal >= 1 && criticalVal <= 50) {
                            await configService.updateConfig('warningThreshold', warningVal);
                            await configService.updateConfig('criticalThreshold', criticalVal);
                            logger.info(`Thresholds updated: warning=${warningVal}%, critical=${criticalVal}%`);
                            vscode.window.showInformationMessage(
                                t('threshold.updated', { value: `Warning: ${warningVal}%, Critical: ${criticalVal}%` }),
                            );
                            // 注意：notifiedModels 清理逻辑通常在 TelemetryController，这里可能无法直接访问
                            // 我们可以让 reactor 重新发送数据，如果 TelemetryController 监听了 configChange 或数据变化，会自动处理？
                            // 最好是这里只更新配置，reprocess 会触发 reactor 的逻辑。
                            // 但 notifiedModels 是内存状态。
                            // 临时方案：不清理，或者通过 reactor 发送一个事件？
                            // 观察 extension.ts，'notifiedModels.clear()' 是直接调用的。
                            // 我们可以将 notifiedModels 移入 TelemetryController 并提供一个 reset 方法。
                            // 这里先保留注释。
                            this.reactor.reprocess();
                        } else {
                            logger.warn('Invalid threshold values received from dashboard');
                        }
                    }
                    break;

                case 'renameModel':
                    if (message.modelId && message.groupName !== undefined) {
                        logger.info(`User renamed model ${message.modelId} to: ${message.groupName}`);
                        await configService.updateModelName(message.modelId, message.groupName);
                        // 使用缓存数据重新渲染
                        this.reactor.reprocess();
                    } else {
                        logger.warn('renameModel signal missing required data');
                    }
                    break;

                case 'updateStatusBarFormat':
                    if (message.statusBarFormat) {
                        logger.info(`User changed status bar format to: ${message.statusBarFormat}`);
                        await configService.updateConfig('statusBarFormat', message.statusBarFormat);
                        // 立即刷新状态栏
                        this.reactor.reprocess();
                    } else {
                        logger.warn('updateStatusBarFormat signal missing statusBarFormat');
                    }
                    break;

                case 'toggleProfile':
                    // 切换计划详情显示/隐藏
                    logger.info('User toggled profile visibility');
                    {
                        const currentConfig = configService.getConfig();
                        await configService.updateConfig('profileHidden', !currentConfig.profileHidden);
                        this.reactor.reprocess();
                    }
                    break;

                case 'updateDisplayMode':
                    if (message.displayMode) {
                        logger.info(`User changed display mode to: ${message.displayMode}`);
                        await configService.updateConfig('displayMode', message.displayMode);

                        if (message.displayMode === 'quickpick') {
                            // 1. 关闭 Webview
                            this.hud.dispose();
                            // 2. 刷新状态栏
                            this.reactor.reprocess();
                            // 3. 立即弹出 QuickPick (通过命令)
                            vscode.commands.executeCommand('agCockpit.open');
                        } else {
                            this.reactor.reprocess();
                        }
                    }
                    break;

                case 'updateQuotaSource':
                    if (message.quotaSource) {
                        await this.applyQuotaSourceChange(message.quotaSource);
                    } else {
                        logger.warn('updateQuotaSource signal missing quotaSource');
                    }
                    break;



                case 'updateDataMasked':
                    // 更新数据遮罩状态
                    if (message.dataMasked !== undefined) {
                        logger.info(`User changed data masking to: ${message.dataMasked}`);
                        await configService.updateConfig('dataMasked', message.dataMasked);
                        this.reactor.reprocess();
                    }
                    break;

                case 'antigravityToolsSync.import':
                    await this.handleAntigravityToolsImport(false);
                    break;

                case 'antigravityToolsSync.importAuto':
                    await this.handleAntigravityToolsImport(true);
                    break;

                case 'antigravityToolsSync.importConfirm':
                    {
                        const activeEmail = await credentialStorage.getActiveAccount();
                        const importOnly = message.importOnly === true;
                        const switchOnly = message.switchOnly === true;
                        const targetEmail = message.targetEmail as string | undefined;

                        if (switchOnly && targetEmail) {
                            // 纯切换场景：直接调用快速切换，无需网络请求
                            await antigravityToolsSyncService.switchOnly(targetEmail);
                            const state = await autoTriggerController.getState();
                            this.hud.sendMessage({ type: 'autoTriggerState', data: state });
                            this.hud.sendMessage({ type: 'antigravityToolsSyncComplete', data: { success: true } });
                            // 修复：切换账号后必须强制执行 syncTelemetry 来获取新账号配额，而不是 reprocess 旧缓存
                            if (configService.getConfig().quotaSource === 'authorized') {
                                const usedCache = await this.reactor.tryUseQuotaCache('authorized', targetEmail);
                                if (!usedCache) {
                                    this.reactor.syncTelemetry();
                                }
                            }
                            vscode.window.showInformationMessage(
                                t('autoTrigger.accountSwitched', { email: targetEmail }) 
                                || `已切换至账号: ${targetEmail}`,
                            );
                        } else {
                            // 需要导入的场景
                            await this.performAntigravityToolsImport(activeEmail, false, importOnly);
                        }
                    }
                    break;

                case 'antigravityToolsSync.importJson':
                    if (typeof message.jsonText === 'string') {
                        await this.performAntigravityToolsJsonImport(message.jsonText);
                    } else {
                        const err = 'JSON 内容为空';
                        this.hud.sendMessage({
                            type: 'antigravityToolsSyncComplete',
                            data: { success: false, error: err },
                        });
                        vscode.window.showWarningMessage(err);
                    }
                    break;

                case 'antigravityToolsSync.cancel':
                    // 用户取消导入
                    if (this.importCancelToken) {
                        this.importCancelToken.cancelled = true;
                        logger.info('[AntigravityToolsSync] 用户取消了导入操作');
                    }
                    break;

                case 'antigravityToolsSync.toggle':
                    if (typeof message.enabled === 'boolean') {
                        // Auto sync has been deprecated and is now fixed OFF.
                        await configService.setStateFlag('antigravityToolsSyncEnabled', false);
                        const autoSwitchEnabled = configService.getStateFlag('antigravityToolsAutoSwitchEnabled', true);
                        this.hud.sendMessage({
                            type: 'antigravityToolsSyncStatus',
                            data: { autoSyncEnabled: false, autoSwitchEnabled },
                        });
                    }
                    break;
                case 'antigravityToolsSync.toggleAutoSwitch':
                    if (typeof message.enabled === 'boolean') {
                        await configService.setStateFlag('antigravityToolsAutoSwitchEnabled', message.enabled);
                        const autoSyncEnabled = configService.getStateFlag('antigravityToolsSyncEnabled', false);
                        this.hud.sendMessage({
                            type: 'antigravityToolsSyncStatus',
                            data: { autoSyncEnabled, autoSwitchEnabled: message.enabled },
                        });
                        if (message.enabled) {
                            await this.handleAntigravityToolsImport(true);
                        }
                    }
                    break;

                case 'antigravityToolsSync.switchToClient':
                    // 切换至当前登录账户
                    await this.handleSwitchToClientAccount();
                    break;

                case 'updateLanguage':
                    // 更新语言设置
                    if (message.language !== undefined) {
                        const rawLanguage = String(message.language);
                        const newLanguage = normalizeLocaleInput(rawLanguage);
                        logger.info(`User changed language to: ${newLanguage}`);
                        await configService.updateConfig('language', newLanguage);
                        // 应用新语言设置
                        i18n.applyLanguageSetting(newLanguage);
                        const languageForSync = newLanguage === 'auto' ? i18n.getLocale() : newLanguage;
                        
                        // 同步语言到桌面端
                        if (cockpitToolsWs.isConnected) {
                            // 在线：通过 WebSocket 同步
                            const syncResult = await cockpitToolsWs.setLanguage(languageForSync, 'extension');
                            if (!syncResult.success) {
                                logger.warn(`[WS] 同步语言到桌面端失败: ${syncResult.message}`);
                            }
                        } else {
                            // 离线：写入共享文件，等桌面端启动时读取
                            const { writeSyncSetting } = await import('../services/syncSettings');
                            writeSyncSetting('language', languageForSync);
                            logger.info(`[SyncSettings] 语言写入共享文件（离线模式）: ${languageForSync}`);
                        }
                        
                        // 关闭当前面板并重新打开
                        this.hud.dispose();
                        // 短暂延迟后重新打开面板，确保旧面板完全关闭
                        setTimeout(() => {
                            vscode.commands.executeCommand('agCockpit.open');
                        }, 100);
                    }
                    break;

                case 'saveCustomGrouping': {
                    // 保存自定义分组
                    const { customGroupMappings, customGroupNames } = message;
                    if (customGroupMappings) {
                        logger.info(`User saved custom grouping: ${Object.keys(customGroupMappings).length} models`);
                        await configService.updateGroupMappings(customGroupMappings);

                        // 清除之前的 pinnedGroups（因为 groupId 可能已变化）
                        await configService.updateConfig('pinnedGroups', []);

                        // 保存分组名称（如果有）
                        if (customGroupNames) {
                            await configService.updateConfig('groupingCustomNames', customGroupNames);
                        }

                        // 刷新 UI
                        this.reactor.reprocess();
                    }
                    break;
                }

                // ============ Auto Trigger ============
                case 'tabChanged':
                    if (message.tab === 'accounts') {
                        await configService.setStateValue('lastActiveView', 'accountsOverview');
                        this.hud.syncAccountsToWebview();
                    } else {
                        await configService.setStateValue('lastActiveView', 'dashboard');
                    }

                    // Tab 切换时，如果切到自动触发 Tab，发送状态更新
                    if (message.tab === 'auto-trigger') {
                        logger.debug('Switched to Auto Trigger tab');
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                    }
                    break;

                case 'quotaHistory.get': {
                    const isValidEmail = (value?: string | null): value is string => typeof value === 'string' && value.includes('@');
                    const requestedEmail = message.email;
                    const activeEmail = await credentialStorage.getActiveAccount();
                    const latestSnapshot = this.reactor.getLatestSnapshot();
                    const snapshotEmail = latestSnapshot?.userInfo?.email || latestSnapshot?.localAccountEmail || null;
                    const resolvedEmail = isValidEmail(requestedEmail)
                        ? requestedEmail
                        : (isValidEmail(activeEmail) ? activeEmail : (isValidEmail(snapshotEmail) ? snapshotEmail : null));

                    const credentials = await credentialStorage.getAllCredentials();
                    const accounts = Object.keys(credentials);
                    if (isValidEmail(snapshotEmail) && !accounts.includes(snapshotEmail)) {
                        accounts.push(snapshotEmail);
                    }
                    accounts.sort();

                    const history = await getQuotaHistory(resolvedEmail, message.rangeDays, message.modelId);
                    this.hud.sendMessage({
                        type: 'quotaHistoryData',
                        data: {
                            email: resolvedEmail,
                            accounts,
                            rangeDays: history?.rangeDays ?? message.rangeDays,
                            modelId: history?.modelId ?? message.modelId ?? null,
                            models: history?.models || [],
                            points: history?.points || [],
                        },
                    });
                    break;
                }

                case 'clearHistorySingle':
                    if (message.email) {
                        logger.info(`User clearing history for account: ${message.email}`);
                        await clearHistory(message.email);
                        this.hud.sendMessage({ type: 'quotaHistoryCleared' });
                        vscode.window.showInformationMessage(t('history.cleared') || 'History cleared.');
                    }
                    break;

                case 'clearHistoryAll':
                    logger.info('User clearing all history');
                    await clearAllHistory();
                    this.hud.sendMessage({ type: 'quotaHistoryCleared' });
                    vscode.window.showInformationMessage(t('history.allCleared') || 'All history cleared.');
                    break;

                case 'autoTrigger.authorize':
                    logger.info('User triggered OAuth authorization');
                    try {
                        await autoTriggerController.authorize();
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (configService.getConfig().quotaSource === 'authorized') {
                            this.reactor.syncTelemetry();
                        }
                    } catch (error) {
                        const err = error instanceof Error ? error : new Error(String(error));
                        logger.error(`Authorization failed: ${err.message}`);
                        vscode.window.showErrorMessage(`Authorization failed: ${err.message}`);
                    }
                    break;

                case 'autoTrigger.importLocal':
                    await this.handleLocalAuthImport();
                    break;
                case 'autoTrigger.importLocalConfirm':
                    await this.handleLocalAuthImportConfirm(message.overwrite === true);
                    break;

                case 'autoTrigger.revoke':
                    logger.info('User revoked OAuth authorization');
                    await autoTriggerController.revokeActiveAccount();
                    {
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                    }
                    if (configService.getConfig().quotaSource === 'authorized') {
                        this.reactor.syncTelemetry();
                    }
                    break;

                case 'autoTrigger.saveSchedule':
                    if (message.schedule) {
                        logger.info('User saved auto trigger schedule');
                        await autoTriggerController.saveSchedule(message.schedule);
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        vscode.window.showInformationMessage(t('autoTrigger.saved'));
                    }
                    break;

                case 'autoTrigger.test':
                    logger.info('User triggered manual test');
                    try {
                        // 从消息中获取自定义模型列表
                        const rawModels = (message as { models?: unknown }).models;
                        const testModels = Array.isArray(rawModels)
                            ? rawModels.filter((model): model is string => typeof model === 'string' && model.length > 0)
                            : undefined;
                        // 获取自定义唤醒词
                        const customPrompt = (message as { customPrompt?: string }).customPrompt;
                        const rawMaxOutputTokens = (message as { maxOutputTokens?: unknown }).maxOutputTokens;
                        const parsedMaxOutputTokens = typeof rawMaxOutputTokens === 'number'
                            ? rawMaxOutputTokens
                            : (typeof rawMaxOutputTokens === 'string' ? Number(rawMaxOutputTokens) : undefined);
                        const maxOutputTokens = typeof parsedMaxOutputTokens === 'number'
                            && Number.isFinite(parsedMaxOutputTokens)
                            && parsedMaxOutputTokens > 0
                            ? Math.floor(parsedMaxOutputTokens)
                            : undefined;
                        const rawAccounts = (message as { accounts?: unknown }).accounts;
                        const testAccounts = Array.isArray(rawAccounts)
                            ? rawAccounts.filter((email): email is string => typeof email === 'string' && email.length > 0)
                            : undefined;
                        const result = await autoTriggerController.triggerNow(testModels, customPrompt, testAccounts, maxOutputTokens);
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (result.success) {
                            // 显示成功消息和 AI 回复
                            const successMsg = t('autoTrigger.triggerSuccess').replace('{duration}', String(result.duration));
                            const responsePreview = result.response
                                ? `\n${result.response.substring(0, 200)}${result.response.length > 200 ? '...' : ''}`
                                : '';
                            vscode.window.showInformationMessage(successMsg + responsePreview);
                        } else {
                            vscode.window.showErrorMessage(
                                t('autoTrigger.triggerFailed').replace('{message}', result.error || 'Unknown error'),
                            );
                        }
                    } catch (error) {
                        const err = error instanceof Error ? error : new Error(String(error));
                        vscode.window.showErrorMessage(
                            t('autoTrigger.triggerFailed').replace('{message}', err.message),
                        );
                    }
                    break;

                case 'autoTrigger.validateCrontab':
                    if (message.crontab) {
                        const result = autoTriggerController.validateCrontab(message.crontab);
                        this.hud.sendMessage({
                            type: 'crontabValidation',
                            data: result,
                        });
                    }
                    break;

                case 'autoTrigger.clearHistory':
                    {
                        logger.info('User cleared trigger history');
                        await autoTriggerController.clearHistory();
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        vscode.window.showInformationMessage(t('autoTrigger.historyCleared'));
                    }
                    break;

                case 'getAutoTriggerState':
                case 'autoTrigger.getState':
                    {
                        const state = await autoTriggerController.getState();
                        const accountCount = state.authorization?.accounts?.length ?? 0;
                        const activeAccount = state.authorization?.activeAccount ?? state.authorization?.email ?? 'none';
                        logger.info(`[Webview] autoTriggerState accounts=${accountCount} active=${activeAccount}`);
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                    }
                    break;

                case 'autoTrigger.addAccount':
                    // Same as authorize - adds a new account
                    logger.info('User adding new account');
                    try {
                        await autoTriggerController.authorize();
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (configService.getConfig().quotaSource === 'authorized') {
                            this.reactor.syncTelemetry();
                        }
                    } catch (error) {
                        const err = error instanceof Error ? error : new Error(String(error));
                        logger.error(`Add account failed: ${err.message}`);
                        vscode.window.showErrorMessage(`Add account failed: ${err.message}`);
                    }
                    break;

                case 'autoTrigger.removeAccount':
                    if (message.email) {
                        logger.info(`User removing account: ${message.email}`);
                        await autoTriggerController.removeAccount(message.email);
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (configService.getConfig().quotaSource === 'authorized') {
                            this.reactor.syncTelemetry();
                        }
                    } else {
                        logger.warn('removeAccount missing email');
                    }
                    break;

                case 'autoTrigger.switchAccount':
                    if (message.email) {
                        logger.info(`User switching to account: ${message.email}`);
                        await autoTriggerController.switchAccount(message.email);
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (configService.getConfig().quotaSource === 'authorized') {
                            const usedCache = await this.reactor.tryUseQuotaCache('authorized', message.email);
                            if (!usedCache) {
                                this.reactor.syncTelemetry();
                            }
                        }
                    } else {
                        logger.warn('switchAccount missing email');
                    }
                    break;

                case 'autoTrigger.switchLoginAccount':
                    // 切换登录账户（实际切换客户端账户，需要通知 Cockpit Tools）
                    if (message.email) {
                        logger.info(`User switching login account to: ${message.email}`);
                        
                        // 检查 WebSocket 连接状态
                        if (!cockpitToolsWs.isConnected) {
                            const action = await vscode.window.showWarningMessage(
                                'Cockpit Tools 未运行，无法切换账号',
                                '启动 Cockpit Tools',
                                '下载 Cockpit Tools',
                            );
                            
                            if (action === '启动 Cockpit Tools') {
                                vscode.commands.executeCommand('agCockpit.accountTree.openManager');
                            } else if (action === '下载 Cockpit Tools') {
                                vscode.env.openExternal(vscode.Uri.parse('https://github.com/jlcodes99/antigravity-cockpit-tools/releases'));
                            }
                            return;
                        }
                        
                        try {
                            // 通过 WebSocket 通知 Cockpit Tools 切换账号
                            const resp = await cockpitToolsWs.getAccounts();
                            const account = resp.accounts.find((a: AccountInfo) => a.email === message.email);
                            
                            if (account && account.id) {
                                const result = await cockpitToolsWs.switchAccount(account.id);
                                if (result.success) {
                                    vscode.window.showInformationMessage(t('autoTrigger.switchLoginSuccess') || `已切换登录账户至 ${message.email}`);
                                } else {
                                    vscode.window.showErrorMessage(t('autoTrigger.switchLoginFailed') || `切换登录账户失败: ${result.message}`);
                                }
                            } else {
                                vscode.window.showErrorMessage(t('autoTrigger.accountNotFound') || '未找到该账户');
                            }
                        } catch (error) {
                            const err = error instanceof Error ? error : new Error(String(error));
                            logger.error(`Switch login account failed: ${err.message}`);
                            vscode.window.showErrorMessage(t('autoTrigger.switchLoginFailed') || `切换登录账户失败: ${err.message}`);
                        }
                    } else {
                        logger.warn('switchLoginAccount missing email');
                    }
                    break;

                case 'autoTrigger.reauthorizeAccount':
                    // Re-authorize logic... (keep existing if any code follows, but here it was just the case label)
                    // ... existing logic ...
                    break; 

                    // ============ Accounts Overview Handlers ============

                case 'refreshAll':
                    if (this.refreshService) {
                        cockpitToolsWs.ensureConnected();
                        const refreshed = await this.refreshService.manualRefresh();
                        if (!refreshed) {
                            this.hud.syncAccountsToWebview();
                        }
                        // refreshService updates notify HUD via subscription in hud.ts
                    }
                    break;

                case 'refreshAccount':
                    if (typeof message.email === 'string' && this.refreshService) {
                        await this.refreshService.loadAccountQuota(message.email);
                    }
                    break;
                
                case 'switchAccount': // Alias for switching client account
                    if (typeof message.email === 'string') {
                        // Reusing autoTrigger.switchLoginAccount logic basically
                        const email = message.email;
                        logger.info(`[MsgCtrl] Switching account to: ${email}`);
                        if (!cockpitToolsWs.isConnected) {
                            const launchAction = t('accountTree.launchCockpitTools');
                            const downloadAction = t('accountTree.downloadCockpitTools');
                            const action = await vscode.window.showWarningMessage(
                                t('accountTree.cockpitToolsNotRunning'),
                                launchAction,
                                downloadAction,
                            );
                            if (action === launchAction) {
                                vscode.commands.executeCommand('agCockpit.accountTree.openManager');
                            } else if (action === downloadAction) {
                                vscode.env.openExternal(vscode.Uri.parse('https://github.com/jlcodes99/antigravity-cockpit-tools/releases'));
                            }
                            return;
                        }
                        try {
                            const resp = await cockpitToolsWs.getAccounts();
                            const account = resp.accounts.find((a: AccountInfo) => a.email.toLowerCase() === email.toLowerCase());
                            if (account && account.id) {
                                const result = await cockpitToolsWs.switchAccount(account.id);
                                if (result.success) {
                                    // active account updated via WS event
                                    this.hud.sendMessage({
                                        type: 'actionResult',
                                        data: { status: 'success', message: t('accountsOverview.switchSuccess', { email }) },
                                    });
                                } else {
                                    this.hud.sendMessage({
                                        type: 'actionResult',
                                        data: { status: 'error', message: result.message },
                                    });
                                }
                            }
                        } catch (e) {
                            const err = e instanceof Error ? e : new Error(String(e));
                            this.hud.sendMessage({
                                type: 'actionResult',
                                data: { status: 'error', message: err.message },
                            });
                        }
                    }
                    break;

                case 'deleteAccount':
                    if (typeof message.email === 'string') {
                        try {
                            await autoTriggerController.removeAccount(message.email);
                            if (this.refreshService) {await this.refreshService.refresh();}
                            this.hud.sendMessage({
                                type: 'actionResult',
                                data: { status: 'success', message: t('accountsOverview.deleteSuccess', { email: message.email }) },
                            });
                        } catch (e) {
                            const err = e instanceof Error ? e : new Error(String(e));
                            this.hud.sendMessage({
                                type: 'actionResult',
                                data: { status: 'error', message: err.message },
                            });
                        }
                    }
                    break;

                case 'deleteAccounts':
                    if (Array.isArray(message.emails)) {
                        let successCount = 0;
                        for (const email of message.emails) {
                            try {
                                await autoTriggerController.removeAccount(email);
                                successCount++;
                            } catch (error) {
                                logger.warn(`Failed to delete ${email}: ${error}`);
                            }
                        }
                        if (this.refreshService) {await this.refreshService.refresh();}
                        this.hud.sendMessage({
                            type: 'actionResult',
                            data: { status: 'success', message: t('accountsOverview.deleteBatchSuccess', { count: successCount }) },
                        });
                    }
                    break;

                case 'addAccount':
                    // Complex add account flow with modes
                    {
                        const mode = typeof message.mode === 'string' ? message.mode : undefined;
                        try {
                            if (mode === 'prepare' || mode === 'start') {
                                const url = await oauthService.prepareAuthorizationSession();
                                this.hud.sendMessage({ type: 'oauthUrl', data: { url } });
                                if (mode === 'start' && url) {
                                    vscode.env.openExternal(vscode.Uri.parse(url));
                                }
                            } else if (mode === 'cancel') {
                                oauthService.cancelAuthorizationSession();
                            } else if (mode === 'continue' || !mode) {
                                // Default flow
                                const success = await oauthService.startAuthorization();
                                if (success) {
                                    if (this.refreshService) {await this.refreshService.refresh();}
                                    this.hud.sendMessage({
                                        type: 'actionResult',
                                        data: { status: 'success', message: t('accountsOverview.addSuccess'), closeModal: true },
                                    });
                                } else {
                                    this.hud.sendMessage({
                                        type: 'actionResult',
                                        data: { status: 'error', message: t('accountsOverview.addFailed', { error: 'Unknown' }) },
                                    });
                                }
                            }
                        } catch (e) {
                            const err = e instanceof Error ? e : new Error(String(e));
                            this.hud.sendMessage({
                                type: 'actionResult',
                                data: { status: 'error', message: err.message },
                            });
                        }
                    }
                    break;

                case 'importTokens':
                    if (typeof message.content === 'string') {
                        // Note: Logic needs to be implemented or imported. 
                        // For now, let's defer or implement basic parsing if possible.
                        // But imported refresh tokens need to be saved to DB.
                        // autoTriggerController doesn't expose raw import? 
                        // Actually `credentialStorage` has `saveCredential`.
                        // Let's implement basic JSON parsing here.
                        try {
                            let tokens: Record<string, unknown>[] = [];
                            try {
                                const parsed = JSON.parse(message.content);
                                tokens = Array.isArray(parsed) ? parsed : [parsed];
                            } catch {
                                tokens = message.content.split('\n').filter(line => line.trim()).map(line => ({ refresh_token: line.trim() }));
                            }
                             
                            let count = 0;
                            let errors = 0;
                            for (const item of tokens) {
                                const refreshToken = item.refresh_token as string | undefined;
                                if (typeof refreshToken === 'string' && refreshToken) {
                                    try {
                                        // 显式断言 email 为 string | undefined
                                        const emailArg = typeof item.email === 'string' ? item.email : undefined;
                                        const credential = await oauthService.buildCredentialFromRefreshToken(refreshToken, emailArg);
                                        await credentialStorage.saveCredentialForAccount(credential.email, credential);
                                        count++;
                                    } catch (error) {
                                        const err = error instanceof Error ? error : new Error(String(error));
                                        errors++;
                                        logger.warn(`Failed to import token: ${err.message}`);
                                    }
                                }
                            }
                             
                            if (count > 0 && this.refreshService) {
                                await this.refreshService.refresh();
                            }

                            let messageText = '';
                            let status: 'success' | 'error' | 'warning' = 'success';
                            if (count > 0) {
                                messageText = t('accountsOverview.tokenImportSuccess') || `Successfully imported ${count} accounts.`;
                                if (errors > 0) {
                                    messageText += ` (${errors} failed)`;
                                    status = 'warning';
                                }
                            } else {
                                messageText = t('accountsOverview.tokenImportFailed') || 'Import failed.';
                                status = 'error';
                            }

                            this.hud.sendMessage({
                                type: 'actionResult',
                                data: { status, message: messageText, closeModal: count > 0 },
                            });
                        } catch (e) {
                            this.hud.sendMessage({
                                type: 'actionResult',
                                data: { status: 'error', message: 'Invalid JSON format' },
                            });
                        }
                    }
                    break;

                case 'importFromExtension':
                    // Reuse antigravityToolsSync logic
                    await this.handleAntigravityToolsImport(false); // force=false? Actually importFromExtension usually means sync.
                    break;

                case 'importFromLocal':
                    await this.handleLocalAuthImport();
                    break;
                
                case 'importFromTools':
                    // Same as antigravityToolsSync.import
                    await this.handleAntigravityToolsImport(false);
                    break;

                case 'exportAccounts':
                    // Generate JSON of accounts and copy to clipboard
                    if (Array.isArray(message.emails)) {
                        const creds = await credentialStorage.getAllCredentials();
                        const exportData = message.emails
                            .filter((e: string) => creds[e])
                            .map((e: string) => ({ email: e, refresh_token: creds[e].refreshToken }));
                         
                        const jsonStr = JSON.stringify(exportData, null, 2);
                        await vscode.env.clipboard.writeText(jsonStr);
                         
                        this.hud.sendMessage({
                            type: 'actionResult',
                            data: { 
                                status: 'success', 
                                message: t('accountsOverview.exportSuccess', { count: exportData.length }) || `Successfully exported ${exportData.length} accounts to clipboard.`, 
                            },
                        });
                    }
                    break;

                    // 重新授权指定账号（先删除再重新授权）
                    if (message.email) {
                        logger.info(`User reauthorizing account: ${message.email}`);
                        try {
                            // 重新走授权流程，会覆盖该账号的 token
                            await autoTriggerController.reauthorizeAccount(message.email);
                            const state = await autoTriggerController.getState();
                            this.hud.sendMessage({
                                type: 'autoTriggerState',
                                data: state,
                            });
                            if (configService.getConfig().quotaSource === 'authorized') {
                                this.reactor.syncTelemetry();
                            }
                            vscode.window.showInformationMessage(t('autoTrigger.reauthorizeSuccess'));
                        } catch (error) {
                            const err = error instanceof Error ? error : new Error(String(error));
                            logger.error(`Reauthorize account failed: ${err.message}`);
                            vscode.window.showErrorMessage(`Reauthorize failed: ${err.message}`);
                        }
                    } else {
                        logger.warn('reauthorizeAccount missing email');
                    }
                    break;


                // ============ Announcements ============
                case 'announcement.getState':
                    {
                        const state = await announcementService.getState();
                        this.hud.sendMessage({
                            type: 'announcementState',
                            data: state,
                        });
                    }
                    break;

                case 'announcement.markAsRead':
                    if (message.id) {
                        await announcementService.markAsRead(message.id);
                        logger.debug(`Marked announcement as read: ${message.id}`);
                        // 更新前端状态
                        const state = await announcementService.getState();
                        this.hud.sendMessage({
                            type: 'announcementState',
                            data: state,
                        });
                    }
                    break;

                case 'announcement.markAllAsRead':
                    await announcementService.markAllAsRead();
                    logger.debug('Marked all announcements as read');
                    {
                        const state = await announcementService.getState();
                        this.hud.sendMessage({
                            type: 'announcementState',
                            data: state,
                        });
                    }
                    break;

                case 'openDashboard':
                    await configService.setStateValue('lastActiveView', 'dashboard');
                    if (typeof message.tab === 'string') {
                        await vscode.commands.executeCommand('agCockpit.open', { tab: message.tab, forceView: 'dashboard' });
                    } else {
                        await vscode.commands.executeCommand('agCockpit.open', { forceView: 'dashboard' });
                    }
                    break;

                case 'openUrl':
                    if (message.url) {
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                    }
                    break;

                case 'executeCommand':
                    if (message.commandId) {
                        const args = message.commandArgs;
                        if (args && Array.isArray(args) && args.length > 0) {
                            await vscode.commands.executeCommand(message.commandId, ...args);
                        } else {
                            await vscode.commands.executeCommand(message.commandId);
                        }
                    }
                    break;

            }
        });
    }

    private async handleLocalAuthImport(): Promise<void> {
        try {
            const snapshotEmail = this.reactor.getLatestSnapshot()?.userInfo?.email;
            const fallbackEmail = snapshotEmail && snapshotEmail !== 'N/A' && snapshotEmail.includes('@')
                ? snapshotEmail
                : undefined;
            const preview = await previewLocalCredential(fallbackEmail);
            this.hud.sendMessage({
                type: 'localAuthImportPrompt',
                data: {
                    email: preview.email,
                    exists: preview.exists,
                },
            });
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`[LocalAuthImport] Failed: ${err.message}`);
            this.hud.sendMessage({
                type: 'localAuthImportError',
                data: {
                    message: err.message,
                },
            });
            vscode.window.showErrorMessage(
                t('quotaSource.importLocalFailed', { message: err.message })
                || `Import failed: ${err.message}`,
            );
        }
    }

    private async handleLocalAuthImportConfirm(overwrite: boolean): Promise<void> {
        try {
            const snapshotEmail = this.reactor.getLatestSnapshot()?.userInfo?.email;
            const fallbackEmail = snapshotEmail && snapshotEmail !== 'N/A' && snapshotEmail.includes('@')
                ? snapshotEmail
                : undefined;
            const result = await commitLocalCredential({ overwrite, fallbackEmail });
            const state = await autoTriggerController.getState();
            this.hud.sendMessage({
                type: 'autoTriggerState',
                data: state,
            });
            if (configService.getConfig().quotaSource === 'authorized') {
                this.reactor.syncTelemetry();
            }
            vscode.window.showInformationMessage(
                t('quotaSource.importLocalSuccess', { email: result.email })
                || `Imported account: ${result.email}`,
            );
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`[LocalAuthImport] Confirm failed: ${err.message}`);
            vscode.window.showErrorMessage(
                t('quotaSource.importLocalFailed', { message: err.message })
                || `Import failed: ${err.message}`,
            );
        }
    }

    /**
     * 读取 AntigravityTools 账号，必要时弹框提示用户确认
     * @param isAuto 是否自动模式
     */
    private async handleAntigravityToolsImport(isAuto: boolean): Promise<void> {
        try {
            const autoSyncEnabled = configService.getStateFlag('antigravityToolsSyncEnabled', false);
            const autoSwitchEnabled = configService.getStateFlag('antigravityToolsAutoSwitchEnabled', true);
            if (isAuto && !autoSyncEnabled && !autoSwitchEnabled) {
                return;
            }
            const detection = await antigravityToolsSyncService.detect();
            const activeEmail = await credentialStorage.getActiveAccount();
            
            // 场景 A：未检测到 AntigravityTools 数据
            if (!detection || !detection.currentEmail) {
                if (!isAuto) {
                    // 手动触发时，提示未检测到
                    this.hud.sendMessage({
                        type: 'antigravityToolsSyncPrompt',
                        data: {
                            promptType: 'not_found',
                        },
                    });
                }
                return;
            }

            const sameAccount = activeEmail
                ? detection.currentEmail.toLowerCase() === activeEmail.toLowerCase()
                : false;

            // 场景 B：有新账户需要导入
            if (detection.newEmails.length > 0) {
                if (isAuto) {
                    if (autoSyncEnabled) {
                        // 自动模式：根据面板可见性决定弹框或静默
                        if (this.hud.isVisible()) {
                            // 面板可见，弹框 + 自动确认
                            this.hud.sendMessage({
                                type: 'antigravityToolsSyncPrompt',
                                data: {
                                    promptType: 'new_accounts',
                                    newEmails: detection.newEmails,
                                    currentEmail: detection.currentEmail,
                                    sameAccount,
                                    autoConfirm: true,
                                    autoConfirmImportOnly: !autoSwitchEnabled,
                                },
                            });
                        } else {
                            // 面板不可见，静默导入
                            await this.performAntigravityToolsImport(activeEmail, true, !autoSwitchEnabled);
                            vscode.window.showInformationMessage(
                                t('antigravityToolsSync.autoImported', { email: detection.currentEmail }) 
                                || `已自动同步账户: ${detection.currentEmail}`,
                            );
                        }
                        return;
                    }
                } else {
                    // 手动模式，弹框让用户选择
                    this.hud.sendMessage({
                        type: 'antigravityToolsSyncPrompt',
                        data: {
                            promptType: 'new_accounts',
                            newEmails: detection.newEmails,
                            currentEmail: detection.currentEmail,
                            sameAccount,
                            autoConfirm: false,
                        },
                    });
                }
                if (!isAuto) {
                    return;
                }
            }

            // 场景 C：无新增，且账号一致则无需切换
            if (sameAccount) {
                if (!isAuto) {
                    vscode.window.showInformationMessage(t('antigravityToolsSync.alreadySynced') || '已同步，无需切换');
                }
                return;
            }

            // 场景 D：无新增账户，但账户不一致
            if (isAuto) {
                if (!autoSwitchEnabled) {
                    return;
                }
                // 自动模式：静默切换（无需网络请求，瞬间完成）
                await antigravityToolsSyncService.switchOnly(detection.currentEmail);
                // 刷新状态
                const state = await autoTriggerController.getState();
                this.hud.sendMessage({ type: 'autoTriggerState', data: state });
                this.hud.sendMessage({ type: 'antigravityToolsSyncComplete', data: { success: true } });
                // 修复：账号切换后必须立即请求获取新账号的配额数据
                if (configService.getConfig().quotaSource === 'authorized') {
                    this.reactor.syncTelemetry();
                }
                logger.info(`AntigravityTools Sync: Auto-switched to ${detection.currentEmail}`);
            } else {
                // 手动模式：弹框询问
                this.hud.sendMessage({
                    type: 'antigravityToolsSyncPrompt',
                    data: {
                        promptType: 'switch_only',
                        currentEmail: detection.currentEmail,
                        localEmail: activeEmail,
                        currentEmailExistsLocally: detection.currentEmailExistsLocally,
                        autoConfirm: false,
                    },
                });
            }
        } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            logger.warn(`Antigravity Tools sync detection failed: ${err}`);
            if (!isAuto) {
                vscode.window.showWarningMessage(err);
            }
        }
    }

    /**
     * 真正执行导入 + 切换，并刷新前端状态
     * @param importOnly 如果为 true，仅导入账户而不切换
     */
    private async performAntigravityToolsImport(activeEmail?: string | null, isAuto: boolean = false, importOnly: boolean = false): Promise<void> {
        // 创建取消令牌
        this.importCancelToken = { cancelled: false };
        
        try {
            // 进度回调：将进度发送到前端
            const onProgress = (current: number, total: number, email: string) => {
                this.hud.sendMessage({
                    type: 'antigravityToolsSyncProgress',
                    data: { current, total, email },
                });
            };

            const result = await antigravityToolsSyncService.importAndSwitch(activeEmail, importOnly, onProgress, this.importCancelToken);
            const state = await autoTriggerController.getState();
            this.hud.sendMessage({
                type: 'autoTriggerState',
                data: state,
            });

            // 通知前端导入完成
            this.hud.sendMessage({
                type: 'antigravityToolsSyncComplete',
                data: { success: true },
            });

            // 如果配额来源是授权模式，自动刷新配额数据
            if (configService.getConfig().quotaSource === 'authorized' && result.currentAvailable) {
                this.reactor.syncTelemetry();
            }

            if (result.skipped.length > 0) {
                const skipMsg = `已跳过 ${result.skipped.length} 个无效账号`;
                logger.warn(`[AntigravityToolsSync] ${skipMsg}`);
                if (!isAuto) {
                    vscode.window.showWarningMessage(skipMsg);
                }
            }

            if (!result.currentAvailable && !importOnly) {
                const warnMsg = '当前账号导入失败，已跳过切换';
                logger.warn(`[AntigravityToolsSync] ${warnMsg}`);
                if (!isAuto) {
                    vscode.window.showWarningMessage(warnMsg);
                }
            }

            if (!isAuto) {
                let message: string;
                if (importOnly) {
                    message = t('antigravityToolsSync.imported');
                } else {
                    message = result.switched
                        ? t('antigravityToolsSync.switched', { email: result.currentEmail })
                        : t('antigravityToolsSync.alreadySynced');
                }
                vscode.window.showInformationMessage(message);
            }
        } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            logger.warn(`Antigravity Tools import failed: ${err}`);

            // 通知前端导入失败
            this.hud.sendMessage({
                type: 'antigravityToolsSyncComplete',
                data: { success: false, error: err },
            });

            vscode.window.showWarningMessage(err);
        } finally {
            // 清理取消令牌
            this.importCancelToken = null;
        }
    }

    /**
     * 手动导入 Antigravity Tools JSON 账号
     */
    private async performAntigravityToolsJsonImport(jsonText: string): Promise<void> {
        // 创建取消令牌
        this.importCancelToken = { cancelled: false };
        
        try {
            // 进度回调：将进度发送到前端
            const onProgress = (current: number, total: number, email: string) => {
                this.hud.sendMessage({
                    type: 'antigravityToolsSyncProgress',
                    data: { current, total, email },
                });
            };

            const result = await antigravityToolsSyncService.importFromJson(jsonText, onProgress, this.importCancelToken);
            const state = await autoTriggerController.getState();
            this.hud.sendMessage({
                type: 'autoTriggerState',
                data: state,
            });

            this.hud.sendMessage({
                type: 'antigravityToolsSyncComplete',
                data: { success: true },
            });

            if (configService.getConfig().quotaSource === 'authorized') {
                this.reactor.syncTelemetry();
            }

            if (result.skipped.length > 0) {
                const skipMsg = `已跳过 ${result.skipped.length} 个无效账号`;
                logger.warn(`[AntigravityToolsSync] ${skipMsg}`);
                vscode.window.showWarningMessage(skipMsg);
            }

            const importedMsg = t('antigravityToolsSync.imported') || '已导入账号';
            vscode.window.showInformationMessage(importedMsg);
        } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            logger.warn(`Antigravity Tools JSON import failed: ${err}`);
            this.hud.sendMessage({
                type: 'antigravityToolsSyncComplete',
                data: { success: false, error: err },
            });
            vscode.window.showWarningMessage(err);
        } finally {
            // 清理取消令牌
            this.importCancelToken = null;
        }
    }

    /**
     * 切换至当前登录账户
     * 优先检测本地 Antigravity 客户端的当前账户，其次检测 Antigravity Tools：
     * - 如果账户已存在于 Cockpit，直接切换
     * - 如果账户不存在，走导入弹框流程
     */
    private async handleSwitchToClientAccount(): Promise<void> {
        try {
            let currentEmail: string | null = null;
            const source = 'local' as const;
            
            // 仅检测本地 Antigravity 客户端读取当前账户
            try {
                const preview = await previewLocalCredential();
                if (preview?.email) {
                    currentEmail = preview.email;
                    logger.info(`[SwitchToClient] Found local client account: ${currentEmail}`);
                }
            } catch (localErr) {
                logger.debug(`[SwitchToClient] Local client detection failed: ${localErr instanceof Error ? localErr.message : localErr}`);
            }
            
            if (!currentEmail) {
                vscode.window.showWarningMessage(
                    t('antigravityToolsSync.noClientAccount') || '未检测到客户端登录账户',
                );
                return;
            }

            const activeEmail = await credentialStorage.getActiveAccount();
            const currentEmailLower = currentEmail.toLowerCase();
            
            // 检查是否已是当前账户
            if (activeEmail && activeEmail.toLowerCase() === currentEmailLower) {
                vscode.window.showInformationMessage(
                    t('antigravityToolsSync.alreadySynced') || '已是当前账户',
                );
                return;
            }

            // 检查账户是否已存在于 Cockpit
            const accounts = await credentialStorage.getAllCredentials();
            const existingEmail = Object.keys(accounts).find(
                email => email.toLowerCase() === currentEmailLower,
            );

            if (existingEmail) {
                // 账户已存在，通过 autoTriggerController 切换（使用互斥锁保护）
                logger.info(`[SwitchToClient] Switching to existing account: ${existingEmail}`);
                await autoTriggerController.switchAccount(existingEmail);
                const state = await autoTriggerController.getState();
                this.hud.sendMessage({ type: 'autoTriggerState', data: state });
                
                // 刷新配额
                const source = configService.getConfig().quotaSource === 'authorized' ? 'authorized' : 'local';
                const usedCache = await this.reactor.tryUseQuotaCache(source, existingEmail);
                if (!usedCache) {
                    this.reactor.syncTelemetry();
                }
                
                vscode.window.showInformationMessage(
                    t('autoTrigger.accountSwitched', { email: existingEmail }) 
                    || `已切换至: ${existingEmail}`,
                );
            } else {
                // 账户不存在，走导入弹框流程
                logger.info(`[SwitchToClient] Account not found, showing import prompt for: ${currentEmail} (source: ${source})`);
                this.hud.sendMessage({
                    type: 'antigravityToolsSyncPrompt',
                    data: {
                        promptType: 'new_accounts',
                        newEmails: [currentEmail],
                        currentEmail: currentEmail,
                        localEmail: source === 'local' ? currentEmail : undefined,
                        sameAccount: false,
                        autoConfirm: false,
                    },
                });
            }
        } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            logger.warn(`[SwitchToClient] Failed: ${err}`);
            vscode.window.showWarningMessage(
                t('antigravityToolsSync.switchFailed', { message: err }) || `切换失败: ${err}`,
            );
        }
    }
}
