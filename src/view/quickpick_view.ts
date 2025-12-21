/**
 * Antigravity Cockpit - QuickPick 视图
 * 使用 VSCode 原生 QuickPick API 显示配额信息
 * 用于 Webview 不可用的环境（如 ArchLinux + VSCode OSS）
 */

import * as vscode from 'vscode';
import { QuotaSnapshot, ModelQuotaInfo } from '../shared/types';
import { configService } from '../shared/config_service';
import { logger } from '../shared/log_service';
import { t } from '../shared/i18n';
import { DISPLAY_MODE } from '../shared/constants';

/** QuickPick 项扩展接口 */
interface QuotaQuickPickItem extends vscode.QuickPickItem {
    /** 模型 ID（用于置顶操作） */
    modelId?: string;
    /** 操作类型 */
    action?: 'refresh' | 'logs' | 'settings' | 'switchToWebview';
}

/**
 * QuickPick 视图管理器
 */
export class QuickPickView {
    private lastSnapshot?: QuotaSnapshot;
    private refreshCallback?: () => void;

    constructor() {
        logger.debug('QuickPickView initialized');
    }

    /**
     * 设置刷新回调
     */
    onRefresh(callback: () => void): void {
        this.refreshCallback = callback;
    }

    /**
     * 更新数据快照
     */
    updateSnapshot(snapshot: QuotaSnapshot): void {
        this.lastSnapshot = snapshot;
    }

    /**
     * 显示 QuickPick 菜单
     */
    async show(): Promise<void> {
        if (!this.lastSnapshot) {
            vscode.window.showWarningMessage(t('dashboard.connecting'));
            return;
        }

        const pick = vscode.window.createQuickPick<QuotaQuickPickItem>();
        pick.title = t('dashboard.title');
        pick.placeholder = t('quickpick.placeholder');
        pick.matchOnDescription = false;
        pick.matchOnDetail = false;
        pick.canSelectMany = false;

        pick.items = this.buildMenuItems();

        // 跟踪当前选中项
        let currentActiveItem: QuotaQuickPickItem | undefined;

        pick.onDidChangeActive(items => {
            currentActiveItem = items[0] as QuotaQuickPickItem;
        });

        pick.onDidAccept(async () => {
            if (!currentActiveItem) return;

            // 处理操作项
            if (currentActiveItem.action) {
                pick.hide();
                await this.handleAction(currentActiveItem.action);
                return;
            }

            // 处理模型置顶切换
            if (currentActiveItem.modelId) {
                const targetModelId = currentActiveItem.modelId;
                
                // 先切换置顶状态
                await configService.togglePinnedModel(targetModelId);
                
                // 获取更新后的置顶状态
                const config = configService.getConfig();
                const isPinnedNow = config.pinnedModels.some(
                    p => p.toLowerCase() === targetModelId.toLowerCase(),
                );
                
                // 局部刷新：只更新被点击项的 label（切换图标）
                const currentItems = [...pick.items] as QuotaQuickPickItem[];
                const targetIndex = currentItems.findIndex(
                    item => item.modelId === targetModelId,
                );
                
                if (targetIndex >= 0) {
                    const oldItem = currentItems[targetIndex];
                    const newPinIcon = isPinnedNow ? '$(pinned)' : '$(circle-outline)';
                    // 替换 label 中的图标（第一个图标是 pin 状态）
                    const newLabel = oldItem.label.replace(
                        /^\$\((pinned|circle-outline)\)/,
                        newPinIcon,
                    );
                    
                    // 创建更新后的项
                    const updatedItem: QuotaQuickPickItem = {
                        ...oldItem,
                        label: newLabel,
                    };
                    currentItems[targetIndex] = updatedItem;
                    
                    // 更新列表并保持选中位置
                    pick.items = currentItems;
                    pick.activeItems = [updatedItem];
                }
            }
        });

        pick.onDidHide(() => {
            pick.dispose();
        });

        pick.show();
    }

    /**
     * 构建菜单项
     */
    private buildMenuItems(): QuotaQuickPickItem[] {
        const items: QuotaQuickPickItem[] = [];
        const snapshot = this.lastSnapshot;
        const config = configService.getConfig();

        // 用户信息（如果有）
        if (snapshot?.userInfo) {
            items.push({
                label: `$(account) ${snapshot.userInfo.name}`,
                description: snapshot.userInfo.planName,
                kind: vscode.QuickPickItemKind.Separator,
            });
        }

        // --- 操作按钮（移动到顶部） ---
        items.push({
            label: t('quickpick.actionsSection'),
            kind: vscode.QuickPickItemKind.Separator,
        });

        items.push({
            label: `🔄 ${t('dashboard.refresh')}`,
            description: '',
            action: 'refresh',
        });

        items.push({
            label: `📋 ${t('help.openLogs')}`,
            description: '',
            action: 'logs',
        });

        items.push({
            label: `⚙️ ${t('quickpick.openSettings')}`,
            description: '',
            action: 'settings',
        });

        items.push({
            label: `🖥️ ${t('quickpick.switchToWebview')}`,
            description: '',
            action: 'switchToWebview',
        });

        // --- 配额模型列表 ---
        items.push({
            label: t('quickpick.quotaSection'),
            kind: vscode.QuickPickItemKind.Separator,
        });

        if (snapshot && snapshot.models.length > 0) {
            const pinnedModels = config.pinnedModels;

            for (const model of snapshot.models) {
                const pct = model.remainingPercentage ?? 0;
                const bar = this.drawProgressBar(pct);
                const isPinned = pinnedModels.some(
                    p => p.toLowerCase() === model.modelId.toLowerCase(),
                );

                // 置顶标识
                const pinIcon = isPinned ? '$(pinned)' : '$(circle-outline)';

                items.push({
                    label: `${pinIcon} ${model.label}`,
                    description: `${bar} ${pct.toFixed(1)}%`,
                    detail: `    ${t('dashboard.resetIn')}: ${model.timeUntilResetFormatted}`,
                    modelId: model.modelId,
                });
            }
        } else {
            items.push({
                label: `$(info) ${t('quickpick.noData')}`,
                description: t('dashboard.connecting'),
            });
        }

        return items;
    }

    /**
     * 绘制进度条
     */
    private drawProgressBar(percentage: number): string {
        const total = 10;
        const filled = Math.round((percentage / 100) * total);
        const empty = total - filled;
        return '▓'.repeat(filled) + '░'.repeat(empty);
    }

    /**
     * 处理操作
     */
    private async handleAction(action: 'refresh' | 'logs' | 'settings' | 'switchToWebview'): Promise<void> {
        switch (action) {
            case 'refresh':
                if (this.refreshCallback) {
                    this.refreshCallback();
                }
                break;
            case 'logs':
                vscode.commands.executeCommand('agCockpit.showLogs');
                break;
            case 'settings':
                vscode.commands.executeCommand('workbench.action.openSettings', 'agCockpit');
                break;
            case 'switchToWebview':
                await configService.updateConfig('displayMode', DISPLAY_MODE.WEBVIEW);
                // 切换回 Webview 时自动开启分组模式
                await configService.updateConfig('groupingEnabled', true);
                vscode.window.showInformationMessage(t('quickpick.switchedToWebview'));
                // 重新打开 Dashboard（这次会用 Webview）
                vscode.commands.executeCommand('agCockpit.open');
                break;
        }
    }
}
