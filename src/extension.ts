/**
 * Antigravity Cockpit - 扩展入口
 * VS Code 扩展的主入口点
 */

import * as vscode from 'vscode';
import { ProcessHunter } from './engine/hunter';
import { ReactorCore } from './engine/reactor';
import { logger } from './shared/log_service';
import { configService, CockpitConfig } from './shared/config_service';
import { t, i18n } from './shared/i18n';
import { CockpitHUD } from './view/hud';
import { QuickPickView } from './view/quickpick_view';
import { initErrorReporter, captureError, flushEvents } from './shared/error_reporter';

// Controllers
import { StatusBarController } from './controller/status_bar_controller';
import { CommandController } from './controller/command_controller';
import { MessageController } from './controller/message_controller';
import { TelemetryController } from './controller/telemetry_controller';
import { autoTriggerController } from './auto_trigger/controller';
import { announcementService } from './announcement';

// 全局模块实例
let hunter: ProcessHunter;
let reactor: ReactorCore;
let hud: CockpitHUD;
let quickPickView: QuickPickView;

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

    // 应用保存的语言设置
    const savedLanguage = configService.getConfig().language;
    if (savedLanguage) {
        i18n.applyLanguageSetting(savedLanguage);
    }

    // 获取插件版本号
    const packageJson = await import('../package.json');
    const version = packageJson.version || 'unknown';

    // 初始化错误上报服务（放在日志之后，其他模块之前）
    initErrorReporter(version);

    logger.info(`Antigravity Cockpit v${version} - Systems Online`);

    // 初始化核心模块
    hunter = new ProcessHunter();
    reactor = new ReactorCore();
    hud = new CockpitHUD(context.extensionUri, context);
    quickPickView = new QuickPickView();
    lastQuotaSource = configService.getConfig().quotaSource === 'authorized' ? 'authorized' : 'local';

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
    _messageController = new MessageController(context, hud, reactor, onRetry);
    _commandController = new CommandController(context, hud, quickPickView, reactor, onRetry);

    // 初始化自动触发控制器
    autoTriggerController.initialize(context);

    // 初始化公告服务
    announcementService.initialize(context);

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
        logger.info('Authorized quota source active, skipping local process scan');
        reactor.startReactor(configService.getRefreshIntervalMs());
        systemOnline = true;
        autoRetryCount = 0;
        statusBar.setLoading();
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
    });
}

/**
 * 扩展停用
 */
export async function deactivate(): Promise<void> {
    logger.info('Antigravity Cockpit: Shutting down...');

    // 刷新待发送的错误事件
    await flushEvents();

    reactor?.shutdown();
    hud?.dispose();
    logger.dispose();
}
