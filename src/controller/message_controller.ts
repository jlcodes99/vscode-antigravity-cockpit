
import * as vscode from 'vscode';
import { CockpitHUD } from '../view/hud';
import { ReactorCore } from '../engine/reactor';
import { configService } from '../shared/config_service';
import { logger } from '../shared/log_service';
import { t, i18n } from '../shared/i18n';
import { WebviewMessage } from '../shared/types';
import { TIMING } from '../shared/constants';
import { autoTriggerController } from '../auto_trigger/controller';
import { credentialStorage } from '../auto_trigger';
import { previewLocalCredential, commitLocalCredential } from '../auto_trigger/local_auth_importer';
import { announcementService } from '../announcement';
import { antigravityToolsSyncService } from '../antigravityTools_sync';

export class MessageController {
    // 跟踪已通知的模型以避免重复弹窗 (虽然主要逻辑在 TelemetryController，但 CheckAndNotify 可能被消息触发吗? 不, 主要是 handleMessage)
    // 这里主要是处理前端发来的指令
    private context: vscode.ExtensionContext;

    constructor(
        context: vscode.ExtensionContext,
        private hud: CockpitHUD,
        private reactor: ReactorCore,
        private onRetry: () => Promise<void>,
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

        logger.info(`User changed quota source to: ${source}`);
        await configService.updateConfig('quotaSource', source);

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

        this.hud.onSignal(async (message: WebviewMessage) => {
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
                    this.reactor.syncTelemetry();
                    {
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
                                this.reactor.syncTelemetry();
                            }
                            vscode.window.showInformationMessage(
                                t('autoTrigger.accountSwitched', { email: targetEmail }) 
                                || `已切换至账号: ${targetEmail}`
                            );
                        } else {
                            // 需要导入的场景
                            await this.performAntigravityToolsImport(activeEmail, false, importOnly);
                        }
                    }
                    break;

                case 'antigravityToolsSync.toggle':
                    if (typeof message.enabled === 'boolean') {
                        await configService.setStateFlag('antigravityToolsSyncEnabled', message.enabled);
                        const autoSwitchEnabled = configService.getStateFlag('antigravityToolsAutoSwitchEnabled', true);
                        this.hud.sendMessage({
                            type: 'antigravityToolsSyncStatus',
                            data: { autoSyncEnabled: message.enabled, autoSwitchEnabled },
                        });
                        if (message.enabled) {
                            await this.handleAntigravityToolsImport(true);
                        }
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
                        const newLanguage = String(message.language);
                        logger.info(`User changed language to: ${newLanguage}`);
                        await configService.updateConfig('language', newLanguage);
                        // 应用新语言设置
                        i18n.applyLanguageSetting(newLanguage);
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
                    logger.info('User cleared trigger history');
                    await autoTriggerController.clearHistory();
                    const state = await autoTriggerController.getState();
                    this.hud.sendMessage({
                        type: 'autoTriggerState',
                        data: state,
                    });
                    vscode.window.showInformationMessage(t('autoTrigger.historyCleared'));
                    break;

                case 'autoTrigger.getState':
                    {
                        const state = await autoTriggerController.getState();
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
                            this.reactor.syncTelemetry();
                        }
                    } else {
                        logger.warn('switchAccount missing email');
                    }
                    break;

                case 'autoTrigger.reauthorizeAccount':
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
                                || `已自动同步账户: ${detection.currentEmail}`
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
        try {
            const result = await antigravityToolsSyncService.importAndSwitch(activeEmail, importOnly);
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
            if (configService.getConfig().quotaSource === 'authorized') {
                this.reactor.syncTelemetry();
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
        }
    }

    /**
     * 切换至当前登录账户
     * 检测 Antigravity Tools 或本地客户端的当前账户：
     * - 如果账户已存在于 Cockpit，直接切换
     * - 如果账户不存在，走导入弹框流程
     */
    private async handleSwitchToClientAccount(): Promise<void> {
        try {
            const detection = await antigravityToolsSyncService.detect();
            
            if (!detection || !detection.currentEmail) {
                // 未检测到客户端账户
                vscode.window.showWarningMessage(
                    t('antigravityToolsSync.noClientAccount') || '未检测到客户端登录账户'
                );
                return;
            }

            const activeEmail = await credentialStorage.getActiveAccount();
            const currentEmail = detection.currentEmail;
            const currentEmailLower = currentEmail.toLowerCase();
            
            // 检查是否已是当前账户
            if (activeEmail && activeEmail.toLowerCase() === currentEmailLower) {
                vscode.window.showInformationMessage(
                    t('antigravityToolsSync.alreadySynced') || '已是当前账户'
                );
                return;
            }

            // 检查账户是否已存在于 Cockpit
            const accounts = await credentialStorage.getAllCredentials();
            const existingEmail = Object.keys(accounts).find(
                email => email.toLowerCase() === currentEmailLower
            );

            if (existingEmail) {
                // 账户已存在，直接切换
                logger.info(`[SwitchToClient] Switching to existing account: ${existingEmail}`);
                await credentialStorage.setActiveAccount(existingEmail);
                const state = await autoTriggerController.getState();
                this.hud.sendMessage({ type: 'autoTriggerState', data: state });
                
                if (configService.getConfig().quotaSource === 'authorized') {
                    this.reactor.syncTelemetry();
                }
                
                vscode.window.showInformationMessage(
                    t('autoTrigger.accountSwitched', { email: existingEmail }) 
                    || `已切换至: ${existingEmail}`
                );
            } else {
                // 账户不存在，走导入弹框流程
                logger.info(`[SwitchToClient] Account not found, showing import prompt for: ${currentEmail}`);
                this.hud.sendMessage({
                    type: 'antigravityToolsSyncPrompt',
                    data: {
                        promptType: 'new_accounts',
                        newEmails: [currentEmail],
                        currentEmail: currentEmail,
                        sameAccount: false,
                        autoConfirm: false,
                    },
                });
            }
        } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            logger.warn(`[SwitchToClient] Failed: ${err}`);
            vscode.window.showWarningMessage(
                t('antigravityToolsSync.switchFailed', { message: err }) || `切换失败: ${err}`
            );
        }
    }
}
