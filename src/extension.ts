/**
 * Antigravity Cockpit - 扩展入口
 * VS Code 扩展的主入口点
 */

import * as vscode from 'vscode';
import { ProcessHunter } from './engine/hunter';
import { ReactorCore } from './engine/reactor';
import { logger } from './shared/log_service';
import { configService, CockpitConfig } from './shared/config_service';
import { t } from './shared/i18n';
import { CockpitHUD } from './view/hud';
import { QuickPickView } from './view/quickpick_view';
import { initErrorReporter, captureError, flushEvents } from './shared/error_reporter';

// Controllers
import { StatusBarController } from './controller/status_bar_controller';
import { CommandController } from './controller/command_controller';
import { MessageController } from './controller/message_controller';
import { TelemetryController } from './controller/telemetry_controller';

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

    // 获取插件版本号
    const packageJson = await import('../package.json');
    const version = packageJson.version || 'unknown';

    // 初始化错误上报服务（放在日志之后，其他模块之前）
    initErrorReporter(version);

    logger.info(`Antigravity Cockpit v${version} - Systems Online`);

    // 初始化核心模块
    hunter = new ProcessHunter();
    reactor = new ReactorCore();
    hud = new CockpitHUD(context.extensionUri);
    quickPickView = new QuickPickView();

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
    _messageController = new MessageController(hud, reactor, onRetry);
    _commandController = new CommandController(context, hud, quickPickView, reactor, onRetry);

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

    // 仅当刷新间隔变化时重启 Reactor
    const newInterval = configService.getRefreshIntervalMs();

    // 如果 Reactor 已经在运行且间隔没有变化，则忽略
    if (systemOnline && reactor.currentInterval !== newInterval) {
        logger.info(`Refresh interval changed from ${reactor.currentInterval}ms to ${newInterval}ms. Restarting Reactor.`);
        reactor.startReactor(newInterval);
    }

    // 对于任何配置变更，立即重新处理最近的数据以更新 UI（如状态栏格式变化）
    // 这确保存储在 lastSnapshot 中的数据使用新配置重新呈现
    reactor.reprocess();
}

/**
 * 启动系统
 */
async function bootSystems(): Promise<void> {
    if (systemOnline) {
        return;
    }

    statusBar.setLoading();

    try {
        const info = await hunter.scanEnvironment(3);

        if (info) {
            reactor.engage(info.connectPort, info.csrfToken);
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
        captureError(error, { phase: 'boot', retryCount: autoRetryCount });

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
