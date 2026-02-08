/**
 * Antigravity Cockpit - 扩展入口
 * VS Code 扩展的主入口点
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ProcessHunter } from './engine/hunter';
import { ReactorCore } from './engine/reactor';
import { logger } from './shared/log_service';
import { setAntigravityUserDataDir } from './shared/antigravity_paths';
import { configService, CockpitConfig } from './shared/config_service';
import { t, i18n, normalizeLocaleInput } from './shared/i18n';
import { CockpitHUD } from './view/hud';
import { QuickPickView } from './view/quickpick_view';
import { initErrorReporter, captureError, flushEvents } from './shared/error_reporter';
import { AccountsRefreshService } from './services/accountsRefreshService';

// Controllers
import { StatusBarController } from './controller/status_bar_controller';
import { CommandController } from './controller/command_controller';
import { MessageController } from './controller/message_controller';
import { TelemetryController } from './controller/telemetry_controller';
import { autoTriggerController } from './auto_trigger/controller';
import { credentialStorage } from './auto_trigger';
import { debugLocalCredentialImport } from './auto_trigger/local_auth_importer';
import { announcementService } from './announcement';

// Account Tree View
import { AccountTreeProvider, registerAccountTreeCommands } from './view/accountTree';

// WebSocket Client
import { cockpitToolsWs } from './services/cockpitToolsWs';
import { cockpitToolsSyncEvents } from './services/cockpitToolsSync';

// 全局模块实例
let hunter: ProcessHunter;
let reactor: ReactorCore;
let hud: CockpitHUD;
let quickPickView: QuickPickView;
let accountsRefreshService: AccountsRefreshService;

// Controllers
let statusBar: StatusBarController;
let _commandController: CommandController;
let _messageController: MessageController;
let _telemetryController: TelemetryController;

let systemOnline = false;
let lastQuotaSource: 'local' | 'authorized';

// 自动重试计数器
let autoRetryCount = 0;
const MAX_AUTO_RETRY = 3;
const AUTO_RETRY_DELAY_MS = 5000;

/**
 * 扩展激活入口
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 初始化日志
    logger.init();
    await configService.initialize(context);

    // 记录当前实例的 user-data-dir（用于读取正确的 state.vscdb）
    try {
        const userDataDir = path.resolve(context.globalStorageUri.fsPath, '..', '..', '..');
        setAntigravityUserDataDir(userDataDir);
        logger.info(`[Startup] Resolved user-data-dir: ${userDataDir}`);
    } catch (err) {
        logger.warn(`[Startup] Failed to resolve user-data-dir: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 应用保存的语言设置
    const savedLanguage = configService.getConfig().language;
    if (savedLanguage) {
        i18n.applyLanguageSetting(savedLanguage);
    }

    // 启动时同步：读取共享配置文件，与本地配置比较时间戳后合并
    try {
        const { mergeSettingOnStartup } = await import('./services/syncSettings');
        const mergedLanguage = mergeSettingOnStartup('language', savedLanguage || 'auto');
        if (mergedLanguage) {
            logger.info(`[SyncSettings] 启动时合并语言设置: ${savedLanguage} -> ${mergedLanguage}`);
            await configService.updateConfig('language', mergedLanguage);
            i18n.applyLanguageSetting(mergedLanguage);
        }
    } catch (err) {
        logger.debug(`[SyncSettings] 启动时同步失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 获取插件版本号
    const packageJson = await import('../package.json');
    const version = packageJson.version || 'unknown';

    // 版本升级时重置可见模型（visibleModels 置空，显示全部）
    const lastVersion = context.globalState.get<string>('state.lastVersion');
    if (lastVersion !== version) {
        logger.info(`[Startup] Version changed (${lastVersion ?? 'none'} -> ${version}), reset visibleModels`);
        await configService.updateVisibleModels([]);
        await context.globalState.update('state.lastVersion', version);
    }

    // 初始化错误上报服务（放在日志之后，其他模块之前）
    initErrorReporter(version);

    logger.info(`Antigravity Cockpit v${version} - Systems Online`);

    // 初始化核心模块
    hunter = new ProcessHunter();
    reactor = new ReactorCore();
    accountsRefreshService = new AccountsRefreshService(reactor);
    hud = new CockpitHUD(context.extensionUri, context, accountsRefreshService);
    quickPickView = new QuickPickView();
    lastQuotaSource = configService.getConfig().quotaSource === 'authorized' ? 'authorized' : 'local';

    // 注册账号总览命令
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.openAccountsOverview', async () => {
            // 保存视图状态：用户选择了账号总览
            await configService.setStateValue('lastActiveView', 'accountsOverview');
            // 切换到 HUD 的账号总览 Tab
            vscode.commands.executeCommand('agCockpit.open', { tab: 'accounts' });
        }),
    );

    // 注册从账号总览返回 Dashboard 的命令
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.backToDashboard', async () => {
            // 保存视图状态：用户选择了返回 Dashboard
            await configService.setStateValue('lastActiveView', 'dashboard');
            // 打开 Dashboard（使用 forceView 确保打开 Dashboard 而不是根据状态判断）
            setTimeout(() => {
                vscode.commands.executeCommand('agCockpit.open', { tab: 'quota', forceView: 'dashboard' });
            }, 100);
        }),
    );

    // 注册 Webview Panel Serializer，确保插件重载后能恢复 panel 引用
    context.subscriptions.push(hud.registerSerializer());

    // 设置 QuickPick 刷新回调
    quickPickView.onRefresh(() => {
        reactor.syncTelemetry();
    });

    // 初始化状态栏控制器
    statusBar = new StatusBarController(context);

    // 定义重试/启动回调
    const onRetry = async () => {
        systemOnline = false;
        await bootSystems();
    };

    // 初始化其他控制器
    _telemetryController = new TelemetryController(reactor, statusBar, hud, quickPickView, onRetry);
    _messageController = new MessageController(context, hud, reactor, onRetry, accountsRefreshService);
    _commandController = new CommandController(context, hud, quickPickView, reactor, onRetry);

    // 初始化自动触发控制器
    autoTriggerController.initialize(context);

    // 启动时自动同步到客户端当前登录账户
    // 必须同步等待完成，避免与后续操作产生竞态条件
    try {
        const syncResult = await autoTriggerController.syncToClientAccountOnStartup();
        if (syncResult === 'switched') {
            logger.info('[Startup] Auto-switched to client account');
        }
    } catch (err) {
        logger.debug(`[Startup] Account sync skipped: ${err instanceof Error ? err.message : err}`);
    }

    // 初始化公告服务
    announcementService.initialize(context);

    // 初始化 Account Tree View
    const accountTreeProvider = new AccountTreeProvider(accountsRefreshService);
    const accountTreeView = vscode.window.createTreeView('agCockpit.accountTree', {
        treeDataProvider: accountTreeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(accountTreeView);
    context.subscriptions.push({ dispose: () => accountsRefreshService.dispose() });
    registerAccountTreeCommands(context, accountTreeProvider);

    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.debugLocalAccount', async () => {
            try {
                const result = await debugLocalCredentialImport();
                vscode.window.showInformationMessage(
                    `Local account: ${result.email ?? 'null'} | DB: ${result.dbPath}`,
                );
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                vscode.window.showErrorMessage(`Local account debug failed: ${err.message}`);
            }
        }),
    );

    // 连接 Cockpit Tools WebSocket
    cockpitToolsWs.connect();
    void accountsRefreshService.refreshOnStartup();

    cockpitToolsSyncEvents.on('localChanged', () => {
        logger.info('[Sync] Webview refreshAccounts');
        hud.sendMessage({ type: 'refreshAccounts' });
    });
    
    // WebSocket 连接成功后刷新账号树
    cockpitToolsWs.on('connected', () => {
        logger.info('[WS] 连接成功，刷新账号列表');
        void accountsRefreshService.refresh({ reason: 'ws.connected' });
    });
    
    // 监听数据变更事件
    cockpitToolsWs.on('dataChanged', async (payload: { source?: string }) => {
        const source = payload?.source ?? 'unknown';
        logger.info(`[WS] 收到数据变更通知: ${source}`);
        // 只同步账号列表，不刷新配额（配额由定时刷新和手动刷新负责）
        await accountsRefreshService.refresh({ forceSync: true, skipQuotaRefresh: true, reason: `dataChanged:${source}` });
        // 通知 Webview 刷新账号数据
        hud.sendMessage({ type: 'refreshAccounts' });
    });
    
    cockpitToolsWs.on('accountSwitched', async (payload: { email: string }) => {
        logger.info(`[WS] 账号已切换: ${payload.email}`);
        
        // 同步本地 Active Account 状态，跳过通知 Tools
        await credentialStorage.setActiveAccount(payload.email, true);

        await accountsRefreshService.refresh({ reason: 'ws.accountSwitched' });
        // 通知 Webview 刷新
        hud.sendMessage({ type: 'accountSwitched', email: payload.email });
        vscode.window.showInformationMessage(t('ws.accountSwitched', { email: payload.email }));
    });
    
    cockpitToolsWs.on('switchError', (payload: { message: string }) => {
        vscode.window.showErrorMessage(t('ws.switchFailed', { message: payload.message }));
    });

    cockpitToolsWs.on('languageChanged', async (payload: { language: string; source?: string }) => {
        const language = payload?.language;
        if (!language) {
            return;
        }
        if (payload?.source === 'extension') {
            return;
        }
        const normalizedLanguage = normalizeLocaleInput(language);
        const currentLanguage = normalizeLocaleInput(configService.getConfig().language);
        if (currentLanguage === normalizedLanguage) {
            return;
        }

        logger.info(`[WS] 语言已同步: ${normalizedLanguage}`);
        await configService.updateConfig('language', normalizedLanguage);
        const localeChanged = i18n.applyLanguageSetting(normalizedLanguage);
        if (localeChanged) {
            hud.dispose();
            setTimeout(() => {
                vscode.commands.executeCommand('agCockpit.open');
            }, 100);
        }
    });

    cockpitToolsWs.on('wakeupOverride', async (payload: { enabled: boolean }) => {
        if (!payload?.enabled) {
            return;
        }
        try {
            const state = await autoTriggerController.getState();
            await autoTriggerController.saveSchedule({
                ...state.schedule,
                enabled: false,
                wakeOnReset: false,
            });
            vscode.window.showInformationMessage(t('ws.wakeupOverride'));
        } catch (err) {
            logger.warn(`[WS] 关闭插件唤醒失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    });

    // 监听配置变化
    context.subscriptions.push(
        configService.onConfigChange(handleConfigChange),
    );

    // 启动系统
    await bootSystems();

    logger.info('Antigravity Cockpit Fully Operational');
}

/**
 * 处理配置变化
 */
async function handleConfigChange(config: CockpitConfig): Promise<void> {
    logger.debug('Configuration changed', config);

    const currentQuotaSource = config.quotaSource === 'authorized' ? 'authorized' : 'local';
    const quotaSourceChanged = currentQuotaSource !== lastQuotaSource;
    if (quotaSourceChanged) {
        logger.info(`Quota source changed: ${lastQuotaSource} -> ${currentQuotaSource}, skipping reprocess`);
        lastQuotaSource = currentQuotaSource;
    }

    // 仅当刷新间隔变化时重启 Reactor
    const newInterval = configService.getRefreshIntervalMs();

    // 如果 Reactor 已经在运行且间隔没有变化，则忽略
    if (systemOnline && reactor.currentInterval !== newInterval) {
        logger.info(`Refresh interval changed from ${reactor.currentInterval}ms to ${newInterval}ms. Restarting Reactor.`);
        reactor.startReactor(newInterval);
    }

    // 对于任何配置变更，立即重新处理最近的数据以更新 UI（如状态栏格式变化）
    // 这确保存储在 lastSnapshot 中的数据使用新配置重新呈现
    if (!quotaSourceChanged) {
        reactor.reprocess();
    }
}

/**
 * 启动系统
 */
async function bootSystems(): Promise<void> {
    if (systemOnline) {
        return;
    }

    const quotaSource = configService.getConfig().quotaSource;
    if (quotaSource === 'authorized') {
        logger.info('Authorized quota source active, starting reactor with background local scan');
        reactor.startReactor(configService.getRefreshIntervalMs());
        systemOnline = true;
        autoRetryCount = 0;
        statusBar.setLoading();
        hunter.scanEnvironment(1)
            .then(info => {
                if (info) {
                    reactor.engage(info.connectPort, info.csrfToken, hunter.getLastDiagnostics());
                    logger.info('Local Antigravity connection detected in authorized mode');
                }
            })
            .catch(err => {
                const error = err instanceof Error ? err : new Error(String(err));
                logger.debug(`Background local scan skipped: ${error.message}`);
            });
        return;
    }

    statusBar.setLoading();

    try {
        const info = await hunter.scanEnvironment(3);

        if (info) {
            reactor.engage(info.connectPort, info.csrfToken, hunter.getLastDiagnostics());
            reactor.startReactor(configService.getRefreshIntervalMs());
            systemOnline = true;
            autoRetryCount = 0; // 重置计数器
            statusBar.setReady();
            logger.info('System boot successful');
        } else {
            // 自动重试机制
            if (autoRetryCount < MAX_AUTO_RETRY) {
                autoRetryCount++;
                logger.info(`Auto-retry ${autoRetryCount}/${MAX_AUTO_RETRY} in ${AUTO_RETRY_DELAY_MS / 1000}s...`);
                statusBar.setLoading(`(${autoRetryCount}/${MAX_AUTO_RETRY})`);

                setTimeout(() => {
                    bootSystems();
                }, AUTO_RETRY_DELAY_MS);
            } else {
                autoRetryCount = 0; // 重置计数器
                handleOfflineState();
            }
        }
    } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.error('Boot Error', error);
        captureError(error, {
            phase: 'boot',
            retryCount: autoRetryCount,
            maxRetries: MAX_AUTO_RETRY,
            retryDelayMs: AUTO_RETRY_DELAY_MS,
            refreshIntervalMs: configService.getRefreshIntervalMs(),
            scan: hunter.getLastDiagnostics(),
        });

        // 自动重试机制（异常情况也自动重试）
        if (autoRetryCount < MAX_AUTO_RETRY) {
            autoRetryCount++;
            logger.info(`Auto-retry ${autoRetryCount}/${MAX_AUTO_RETRY} after error in ${AUTO_RETRY_DELAY_MS / 1000}s...`);
            statusBar.setLoading(`(${autoRetryCount}/${MAX_AUTO_RETRY})`);

            setTimeout(() => {
                bootSystems();
            }, AUTO_RETRY_DELAY_MS);
        } else {
            autoRetryCount = 0; // 重置计数器
            statusBar.setError(error.message);

            // 显示系统弹框
            vscode.window.showErrorMessage(
                `${t('notify.bootFailed')}: ${error.message}`,
                t('help.retry'),
                t('help.openLogs'),
            ).then(selection => {
                if (selection === t('help.retry')) {
                    vscode.commands.executeCommand('agCockpit.retry');
                } else if (selection === t('help.openLogs')) {
                    logger.show();
                }
            });
        }
    }
}

/**
 * 处理离线状态
 */
function handleOfflineState(): void {
    if (configService.getConfig().quotaSource === 'authorized') {
        logger.info('Skipping local offline state due to authorized quota source');
        return;
    }
    statusBar.setOffline();

    // 显示带操作按钮的消息
    vscode.window.showErrorMessage(
        t('notify.offline'),
        t('help.retry'),
        t('help.openLogs'),
    ).then(selection => {
        if (selection === t('help.retry')) {
            vscode.commands.executeCommand('agCockpit.retry');
        } else if (selection === t('help.openLogs')) {
            logger.show();
        }
    });

    // 更新 Dashboard 显示离线状态
    hud.refreshView(ReactorCore.createOfflineSnapshot(t('notify.offline')), {
        showPromptCredits: false,
        pinnedModels: [],
        modelOrder: [],
        groupingEnabled: false,
        groupCustomNames: {},
        groupingShowInStatusBar: false,
        pinnedGroups: [],
        groupOrder: [],
        refreshInterval: 120,
        notificationEnabled: false,
        language: configService.getConfig().language,
        quotaSource: 'local', // 必须传递 quotaSource，否则前端切换逻辑无法完成
    });
}

/**
 * 扩展停用
 */
export async function deactivate(): Promise<void> {
    logger.info('Antigravity Cockpit: Shutting down...');

    // 断开 WebSocket 连接
    cockpitToolsWs.disconnect();

    // 刷新待发送的错误事件
    await flushEvents();

    reactor?.shutdown();
    hud?.dispose();
    logger.dispose();
}
