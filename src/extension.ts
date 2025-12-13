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
import { QUOTA_THRESHOLDS, STATUS_BAR_FORMAT, FEEDBACK_URL } from './shared/constants';
import { QuotaSnapshot, WebviewMessage } from './shared/types';

// 全局模块实例
let hunter: ProcessHunter;
let reactor: ReactorCore;
let hud: CockpitHUD;
let statusBarItem: vscode.StatusBarItem;
let systemOnline = false;

// 离线状态跟踪
let lastSuccessfulUpdate: Date | null = null;

// 用于跟踪已经通知过的模型（避免重复通知）
const notifiedModels: Set<string> = new Set();

/**
 * 扩展激活入口
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 初始化日志
    logger.init();
    logger.info('Antigravity Cockpit Systems: Online');

    // 初始化模块
    hunter = new ProcessHunter();
    reactor = new ReactorCore();
    hud = new CockpitHUD(context.extensionUri);

    // 创建状态栏
    statusBarItem = createStatusBar(context);

    // 注册命令
    registerCommands(context);

    // 设置消息处理
    setupMessageHandling();

    // 设置遥测数据处理
    setupTelemetryHandling();

    // 监听配置变化
    context.subscriptions.push(
        configService.onConfigChange(handleConfigChange),
    );

    // 启动系统
    await bootSystems();

    logger.info('Antigravity Cockpit Fully Operational');
}

/**
 * 创建状态栏项
 */
function createStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100,
    );
    
    item.command = 'agCockpit.open';
    item.text = `$(rocket) ${t('statusBar.init')}`;
    item.tooltip = t('statusBar.tooltip');
    item.show();
    
    context.subscriptions.push(item);
    return item;
}

/**
 * 注册命令
 */
function registerCommands(context: vscode.ExtensionContext): void {
    // 打开 Dashboard
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.open', () => {
            hud.revealHud();
        }),
    );

    // 手动刷新
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.refresh', () => {
            reactor.syncTelemetry();
            vscode.window.showInformationMessage(t('notify.refreshing'));
        }),
    );

    // 显示日志
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.showLogs', () => {
            logger.show();
        }),
    );

    // 重试连接
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.retry', async () => {
            systemOnline = false;
            await bootSystems();
        }),
    );

    // 打开反馈页面
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.openFeedback', () => {
            vscode.env.openExternal(vscode.Uri.parse(FEEDBACK_URL));
        }),
    );

    // 设置警告阈值
    context.subscriptions.push(
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
                reactor.reprocess();
            }
        }),
    );

    // 设置危险阈值
    context.subscriptions.push(
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
                reactor.reprocess();
            }
        }),
    );
}

/**
 * 设置 Webview 消息处理
 */
function setupMessageHandling(): void {
    hud.onSignal(async (message: WebviewMessage) => {
        switch (message.command) {
            case 'togglePin':
                logger.info(`Received togglePin signal: ${JSON.stringify(message)}`);
                if (message.modelId) {
                    await configService.togglePinnedModel(message.modelId);
                    reactor.reprocess();
                } else {
                    logger.warn('togglePin signal missing modelId');
                }
                break;

            case 'toggleCredits':
                logger.info('User toggled Prompt Credits display');
                await configService.toggleShowPromptCredits();
                reactor.reprocess();
                break;

            case 'updateOrder':
                if (message.order) {
                    logger.info(`User updated model order. Count: ${message.order.length}`);
                    await configService.updateModelOrder(message.order);
                    reactor.reprocess();
                } else {
                    logger.warn('updateOrder signal missing order data');
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
                reactor.reprocess();
                break;
            }

            case 'refresh':
                logger.info('User triggered manual refresh');
                reactor.syncTelemetry();
                break;

            case 'init':
                if (reactor.hasCache) {
                    logger.info('Dashboard initialized (reprocessing cached data)');
                    reactor.reprocess();
                } else {
                    logger.info('Dashboard initialized (no cache, performing full sync)');
                    reactor.syncTelemetry();
                }
                break;

            case 'retry':
                logger.info('User triggered connection retry');
                systemOnline = false;
                await bootSystems();
                break;

            case 'openLogs':
                logger.info('User opened logs');
                logger.show();
                break;

            case 'rerender':
                logger.info('Dashboard requested re-render');
                reactor.reprocess();
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
                        const latestSnapshot = reactor.getLatestSnapshot();
                        if (latestSnapshot && latestSnapshot.models.length > 0) {
                            const newMappings = ReactorCore.calculateGroupMappings(latestSnapshot.models);
                            await configService.updateGroupMappings(newMappings);
                            logger.info(`First-time grouping: auto-grouped ${Object.keys(newMappings).length} models`);
                        }
                    }
                }
                // 使用缓存数据重新渲染
                reactor.reprocess();
                break;
            }

            case 'renameGroup':
                if (message.modelIds && message.groupName) {
                    logger.info(`User renamed group to: ${message.groupName}`);
                    await configService.updateGroupName(message.modelIds, message.groupName);
                    // 使用缓存数据重新渲染
                    reactor.reprocess();
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
                        reactor.reprocess();
                    }
                } else {
                    logger.warn('promptRenameGroup signal missing required data');
                }
                break;

            case 'toggleGroupPin':
                if (message.groupId) {
                    logger.info(`Toggling group pin: ${message.groupId}`);
                    await configService.togglePinnedGroup(message.groupId);
                    reactor.reprocess();
                } else {
                    logger.warn('toggleGroupPin signal missing groupId');
                }
                break;

            case 'updateGroupOrder':
                if (message.order) {
                    logger.info(`User updated group order. Count: ${message.order.length}`);
                    await configService.updateGroupOrder(message.order);
                    reactor.reprocess();
                } else {
                    logger.warn('updateGroupOrder signal missing order data');
                }
                break;

            case 'autoGroup': {
                logger.info('User triggered auto-grouping');
                // 获取最新的快照数据
                const latestSnapshot = reactor.getLatestSnapshot();
                if (latestSnapshot && latestSnapshot.models.length > 0) {
                    // 计算新的分组映射
                    const newMappings = ReactorCore.calculateGroupMappings(latestSnapshot.models);
                    await configService.updateGroupMappings(newMappings);
                    logger.info(`Auto-grouped ${Object.keys(newMappings).length} models`);
                    
                    // 清除之前的 pinnedGroups（因为 groupId 已变化）
                    await configService.updateConfig('pinnedGroups', []);
                    
                    // 重新处理数据以刷新 UI
                    reactor.reprocess();
                } else {
                    logger.warn('No snapshot data available for auto-grouping');
                }
                break;
            }

            case 'updateThresholds':
                // 处理从 Dashboard 设置模态框发来的阈值更新
                if (message.warningThreshold !== undefined && message.criticalThreshold !== undefined) {
                    const notificationEnabled = message.notificationEnabled as boolean | undefined;
                    const warningVal = message.warningThreshold as number;
                    const criticalVal = message.criticalThreshold as number;

                    if (criticalVal < warningVal && warningVal >= 5 && warningVal <= 80 && criticalVal >= 1 && criticalVal <= 50) {
                        // 保存通知开关状态
                        if (notificationEnabled !== undefined) {
                            await configService.updateConfig('notificationEnabled', notificationEnabled);
                            logger.info(`Notification enabled: ${notificationEnabled}`);
                        }
                        await configService.updateConfig('warningThreshold', warningVal);
                        await configService.updateConfig('criticalThreshold', criticalVal);
                        logger.info(`Thresholds updated: warning=${warningVal}%, critical=${criticalVal}%`);
                        vscode.window.showInformationMessage(
                            t('threshold.updated', { value: `Warning: ${warningVal}%, Critical: ${criticalVal}` }),
                        );
                        // 清除通知记录，让新阈值生效
                        notifiedModels.clear();
                        reactor.reprocess();
                    } else {
                        logger.warn('Invalid threshold values received from dashboard');
                    }
                }
                break;
        }
    });
}

/**
 * 设置遥测数据处理
 */
function setupTelemetryHandling(): void {
    reactor.onTelemetry(async (snapshot: QuotaSnapshot) => {
        let config = configService.getConfig();

        // 记录最后成功更新时间
        lastSuccessfulUpdate = new Date();

        // 成功获取数据，重置错误状态
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = t('statusBar.tooltip');

        // 检查配额并发送通知
        checkAndNotifyQuota(snapshot, config);

        // 自动将新分组添加到 pinnedGroups（第一次开启分组时默认全部显示在状态栏）
        if (config.groupingEnabled && snapshot.groups && snapshot.groups.length > 0) {
            const currentPinnedGroups = config.pinnedGroups;
            const allGroupIds = snapshot.groups.map(g => g.groupId);
            
            // 如果 pinnedGroups 为空，说明是第一次开启分组，自动 pin 全部
            if (currentPinnedGroups.length === 0) {
                logger.info(`Auto-pinning all ${allGroupIds.length} groups to status bar`);
                await configService.updateConfig('pinnedGroups', allGroupIds);
                // 重新获取配置
                config = configService.getConfig();
            }
        }

        // 更新 Dashboard（使用可能已更新的 config）
        hud.refreshView(snapshot, {
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
            lastSuccessfulUpdate: lastSuccessfulUpdate,
        });

        // 更新状态栏
        updateStatusBar(snapshot, config);
    });

    reactor.onMalfunction(async (err: Error) => {
        logger.error(`Reactor Malfunction: ${err.message}`);

        // 如果是连接被拒绝（ECONNREFUSED），说明端口可能变了，直接重新扫描
        if (err.message.includes('ECONNREFUSED') || err.message.includes('Signal Lost')) {
            logger.warn('Connection lost, initiating immediate re-scan protocol...');
            systemOnline = false;
            // 立即尝试重新启动系统（重新扫描端口）
            await bootSystems();
            return;
        }

        statusBarItem.text = `$(error) ${t('status.error')}`;
        statusBarItem.tooltip = err.message;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        
        // 显示系统弹框
        vscode.window.showErrorMessage(
            `${t('notify.bootFailed')}: ${err.message}`,
            t('help.retry'),
            t('help.openLogs'),
        ).then(selection => {
            if (selection === t('help.retry')) {
                vscode.commands.executeCommand('agCockpit.retry');
            } else if (selection === t('help.openLogs')) {
                logger.show();
            }
        });
    });
}

/**
 * 更新状态栏显示
 */
function updateStatusBar(snapshot: QuotaSnapshot, config: CockpitConfig): void {
    const statusTextParts: string[] = [];
    let minPercentage = 100;

    // 检查是否启用分组显示
    if (config.groupingEnabled && config.groupingShowInStatusBar && snapshot.groups && snapshot.groups.length > 0) {
        // 获取置顶的分组
        const monitoredGroups = snapshot.groups.filter(g =>
            config.pinnedGroups.includes(g.groupId),
        );

        if (monitoredGroups.length > 0) {
            // 对置顶分组按 config.groupOrder 排序
            if (config.groupOrder.length > 0) {
                monitoredGroups.sort((a, b) => {
                    const idxA = config.groupOrder.indexOf(a.groupId);
                    const idxB = config.groupOrder.indexOf(b.groupId);
                    // 如果都在排序列表中，按列表顺序
                    if (idxA !== -1 && idxB !== -1) {return idxA - idxB;}
                    // 如果一个在列表一个不在，在列表的优先
                    if (idxA !== -1) {return -1;}
                    if (idxB !== -1) {return 1;}
                    // 都不在，保持原序
                    return 0;
                });
            }

            // 显示置顶分组
            monitoredGroups.forEach(g => {
                const pct = g.remainingPercentage;
                const text = formatStatusBarText(g.groupName, pct, config.statusBarFormat, config);
                statusTextParts.push(text);
                if (pct < minPercentage) {
                    minPercentage = pct;
                }
            });
        } else {
            // 显示最低配额分组，格式改为 "最低: xx%"
            let lowestPct = 100;
            let lowestGroup = snapshot.groups[0];

            snapshot.groups.forEach(g => {
                const pct = g.remainingPercentage;
                if (pct < lowestPct) {
                    lowestPct = pct;
                    lowestGroup = g;
                }
            });

            if (lowestGroup) {
                statusTextParts.push(`${t('statusBar.lowest')}: ${Math.floor(lowestPct)}%`);
                minPercentage = lowestPct;
            }
        }
    } else {
        // 原始逻辑：显示模型
        // 获取置顶的模型
        const monitoredModels = snapshot.models.filter(m =>
            config.pinnedModels.some(p =>
                p.toLowerCase() === m.modelId.toLowerCase() ||
                p.toLowerCase() === m.label.toLowerCase(),
            ),
        );

        if (monitoredModels.length > 0) {
            // 对置顶模型按 config.modelOrder 排序
            if (config.modelOrder.length > 0) {
                monitoredModels.sort((a, b) => {
                    const idxA = config.modelOrder.indexOf(a.modelId);
                    const idxB = config.modelOrder.indexOf(b.modelId);
                    if (idxA !== -1 && idxB !== -1) {return idxA - idxB;}
                    if (idxA !== -1) {return -1;}
                    if (idxB !== -1) {return 1;}
                    return 0;
                });
            }

            // 显示置顶模型
            monitoredModels.forEach(m => {
                const pct = m.remainingPercentage ?? 0;
                const text = formatStatusBarText(m.label, pct, config.statusBarFormat, config);
                statusTextParts.push(text);
                if (pct < minPercentage) {
                    minPercentage = pct;
                }
            });
        } else {
            // 显示最低配额模型
            let lowestPct = 100;
            let lowestModel = snapshot.models[0];

            snapshot.models.forEach(m => {
                const pct = m.remainingPercentage ?? 0;
                if (pct < lowestPct) {
                    lowestPct = pct;
                    lowestModel = m;
                }
            });

            if (lowestModel) {
                statusTextParts.push(`${t('statusBar.lowest')}: ${Math.floor(lowestPct)}%`);
                minPercentage = lowestPct;
            }
        }
    }

    // 更新状态栏（每个模型/分组前面显示颜色球，不再使用背景色）
    if (statusTextParts.length > 0) {
        statusBarItem.text = statusTextParts.join(' | ');
    } else {
        statusBarItem.text = `🟢 ${t('statusBar.ready')}`;
    }

    // 移除背景色，改用每个项目前的颜色球区分
    statusBarItem.backgroundColor = undefined;

    // 更新悬浮提示 - 卡片式布局显示配额详情
    statusBarItem.tooltip = generateQuotaTooltip(snapshot, config);
}

/**
 * 生成配额悬浮提示（使用 Markdown 表格保证对齐）
 */
function generateQuotaTooltip(snapshot: QuotaSnapshot, config: CockpitConfig): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    // 标题行
    const planInfo = snapshot.userInfo?.planName ? ` | ${snapshot.userInfo.planName}` : '';
    md.appendMarkdown(`**🚀 ${t('dashboard.title')}${planInfo}**\n\n`);

    // 排序逻辑与仪表盘保持一致
    const sortedModels = [...snapshot.models];
    if (config.modelOrder && config.modelOrder.length > 0) {
        // 有自定义顺序时，按用户拖拽设置的顺序排序
        const orderMap = new Map<string, number>();
        config.modelOrder.forEach((id, index) => orderMap.set(id, index));
        sortedModels.sort((a, b) => {
            const idxA = orderMap.has(a.modelId) ? orderMap.get(a.modelId)! : 99999;
            const idxB = orderMap.has(b.modelId) ? orderMap.get(b.modelId)! : 99999;
            return idxA - idxB;
        });
    }
    // 没有自定义顺序时，保持 API 返回的原始顺序

    // 构建 Markdown 表格
    // 表头留空以保持整洁，或者使用简单的符号
    md.appendMarkdown('| | | |\n');
    md.appendMarkdown('| :--- | :--- | :--- |\n');

    for (const model of sortedModels) {
        const pct = model.remainingPercentage ?? 0;
        const icon = getStatusIcon(pct, config);
        const bar = generateCompactProgressBar(pct);
        const resetTime = model.timeUntilResetFormatted || '-';

        // 使用完整模型名称
        // 格式：| 🟡 **Name** | `进度条` | 32.59% → time |
        const pctDisplay = (Math.floor(pct * 100) / 100).toFixed(2);
        md.appendMarkdown(`| ${icon} **${model.label}** | \`${bar}\` | ${pctDisplay}% → ${resetTime} |\n`);
    }

    // 底部提示
    md.appendMarkdown(`\n---\n*${t('statusBar.tooltip')}*`);

    return md;
}

/**
 * 生成紧凑进度条 (7格)
 */
function generateCompactProgressBar(percentage: number): string {
    const total = 7;
    const filled = Math.round((percentage / 100) * total);
    const empty = total - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * 获取模型短名称
 * @deprecated 保留以备将来使用
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getShortModelName(label: string): string {
    // 移除常见前缀，保留核心名称
    if (label.includes('Claude')) {
        if (label.includes('Opus')) {return 'Claude Opus';}
        if (label.includes('Sonnet')) {return 'Claude Sonnet';}
        if (label.includes('Thinking')) {return 'Claude Think';}
        return 'Claude';
    }
    if (label.includes('Gemini')) {
        if (label.includes('Flash')) {return 'Gemini Flash';}
        if (label.includes('Pro') && label.includes('High')) {return 'Gemini Pro(H)';}
        if (label.includes('Pro') && label.includes('Low')) {return 'Gemini Pro(L)';}
        if (label.includes('Pro')) {return 'Gemini Pro';}
        return 'Gemini';
    }
    if (label.includes('GPT')) {
        return 'GPT-OSS';
    }
    // 默认：取前 13 个字符
    return label.length > 13 ? label.substring(0, 13) + '..' : label;
}

/**
 * 获取状态图标（基于配置的阈值）
 */
function getStatusIcon(percentage: number, config?: CockpitConfig): string {
    const warningThreshold = config?.warningThreshold ?? QUOTA_THRESHOLDS.WARNING_DEFAULT;
    const criticalThreshold = config?.criticalThreshold ?? QUOTA_THRESHOLDS.CRITICAL_DEFAULT;
    
    if (percentage <= criticalThreshold) {return '🔴';}  // 危险
    if (percentage <= warningThreshold) {return '🟡';}    // 警告
    return '🟢'; // 健康
}

/**
 * 格式化状态栏文本（带颜色球前缀）
 */
function formatStatusBarText(label: string, percentage: number, format: string, config?: CockpitConfig): string {
    const icon = getStatusIcon(percentage, config);
    switch (format) {
        case STATUS_BAR_FORMAT.COMPACT:
            return `${icon} ${Math.floor(percentage)}%`;
        case STATUS_BAR_FORMAT.DETAILED:
            return `${icon} ${label}: ${percentage.toFixed(1)}%`;
        case STATUS_BAR_FORMAT.STANDARD:
        default:
            return `${icon} ${label}: ${Math.floor(percentage)}%`;
    }
}

/**
 * 检查配额并发送通知
 * 当配额达到警告或危险阈值时弹框提醒
 */
function checkAndNotifyQuota(snapshot: QuotaSnapshot, config: CockpitConfig): void {
    if (!config.notificationEnabled) {
        return;
    }

    const warningThreshold = config.warningThreshold ?? QUOTA_THRESHOLDS.WARNING_DEFAULT;
    const criticalThreshold = config.criticalThreshold ?? QUOTA_THRESHOLDS.CRITICAL_DEFAULT;

    for (const model of snapshot.models) {
        const pct = model.remainingPercentage ?? 0;
        const notifyKey = `${model.modelId}-${pct <= criticalThreshold ? 'critical' : 'warning'}`;

        // 如果已经通知过这个状态，跳过
        if (notifiedModels.has(notifyKey)) {
            continue;
        }

        // 危险阈值通知（红色）
        if (pct <= criticalThreshold && pct > 0) {
            // 清除之前的 warning 通知记录（如果有）
            notifiedModels.delete(`${model.modelId}-warning`);
            notifiedModels.add(notifyKey);
            
            vscode.window.showWarningMessage(
                t('threshold.notifyCritical', { model: model.label, percent: pct.toFixed(1) }),
                t('dashboard.refresh'),
            ).then(selection => {
                if (selection === t('dashboard.refresh')) {
                    reactor.syncTelemetry();
                }
            });
            logger.info(`Critical threshold notification sent for ${model.label}: ${pct}%`);
        }
        // 警告阈值通知（黄色）
        else if (pct <= warningThreshold && pct > criticalThreshold) {
            notifiedModels.add(notifyKey);
            
            vscode.window.showInformationMessage(
                t('threshold.notifyWarning', { model: model.label, percent: pct.toFixed(1) }),
            );
            logger.info(`Warning threshold notification sent for ${model.label}: ${pct}%`);
        }
        // 配额恢复时清除通知记录
        else if (pct > warningThreshold) {
            notifiedModels.delete(`${model.modelId}-warning`);
            notifiedModels.delete(`${model.modelId}-critical`);
        }
    }
}

/**
 * 处理配置变化
 */
function handleConfigChange(config: CockpitConfig): void {
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

/** 自动重试计数器 */
let autoRetryCount = 0;
const MAX_AUTO_RETRY = 3;
const AUTO_RETRY_DELAY_MS = 5000;

/**
 * 启动系统
 */
async function bootSystems(): Promise<void> {
    if (systemOnline) {
        return;
    }

    statusBarItem.text = `$(sync~spin) ${t('statusBar.connecting')}`;
    statusBarItem.backgroundColor = undefined;

    try {
        const info = await hunter.scanEnvironment(3);

        if (info) {
            reactor.engage(info.connectPort, info.csrfToken);
            reactor.startReactor(configService.getRefreshIntervalMs());
            systemOnline = true;
            autoRetryCount = 0; // 重置计数器
            statusBarItem.text = `$(rocket) ${t('statusBar.ready')}`;
            logger.info('System boot successful');
        } else {
            // 自动重试机制
            if (autoRetryCount < MAX_AUTO_RETRY) {
                autoRetryCount++;
                logger.info(`Auto-retry ${autoRetryCount}/${MAX_AUTO_RETRY} in ${AUTO_RETRY_DELAY_MS / 1000}s...`);
                statusBarItem.text = `$(sync~spin) ${t('statusBar.connecting')} (${autoRetryCount}/${MAX_AUTO_RETRY})`;
                
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
        
        // 自动重试机制（异常情况也自动重试）
        if (autoRetryCount < MAX_AUTO_RETRY) {
            autoRetryCount++;
            logger.info(`Auto-retry ${autoRetryCount}/${MAX_AUTO_RETRY} after error in ${AUTO_RETRY_DELAY_MS / 1000}s...`);
            statusBarItem.text = `$(sync~spin) ${t('statusBar.connecting')} (${autoRetryCount}/${MAX_AUTO_RETRY})`;
            
            setTimeout(() => {
                bootSystems();
            }, AUTO_RETRY_DELAY_MS);
        } else {
            autoRetryCount = 0; // 重置计数器
            statusBarItem.text = `$(error) ${t('statusBar.error')}`;
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            
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
    statusBarItem.text = `$(error) ${t('statusBar.offline')}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

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
export function deactivate(): void {
    logger.info('Antigravity Cockpit: Shutting down...');
    
    reactor?.shutdown();
    hud?.dispose();
    logger.dispose();
}
