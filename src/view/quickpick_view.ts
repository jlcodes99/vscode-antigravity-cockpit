/**
 * Antigravity Cockpit - QuickPick 视图
 * 使用 VSCode 原生 QuickPick API 显示配额信息
 * 用于 Webview 不可用的环境（如 ArchLinux + VSCode OSS）
 */

import * as vscode from 'vscode';
import { QuotaSnapshot, QuotaGroup } from '../shared/types';
import { configService } from '../shared/config_service';
import { logger } from '../shared/log_service';
import { t } from '../shared/i18n';
import { DISPLAY_MODE } from '../shared/constants';
import { ReactorCore } from '../engine/reactor';

/** 按钮标识 */
const BUTTON_ID = {
    RENAME: 'rename',
    RESET: 'reset',
};

/** QuickPick 项扩展接口 */
interface QuotaQuickPickItem extends vscode.QuickPickItem {
    /** 模型 ID（用于置顶操作，非分组模式） */
    modelId?: string;
    /** 分组 ID（分组模式） */
    groupId?: string;
    /** 分组内的模型 ID 列表 */
    groupModelIds?: string[];
    /** 操作类型 */
    action?: 'openActions' | 'refresh' | 'logs' | 'settings' | 'switchToWebview' | 'toggleGrouping' | 'autoGroup' | 'back';
    /** 原始名称（用于重命名时显示原名） */
    originalLabel?: string;
}

/** 自定义按钮接口 */
interface IdentifiableButton extends vscode.QuickInputButton {
    id: string;
}

/** 标题栏按钮 ID */
const TITLE_BUTTON_ID = {
    REFRESH: 'refresh',
    TOGGLE_GROUPING: 'toggleGrouping',
    AUTO_GROUP: 'autoGroup',
    LOGS: 'logs',
    SETTINGS: 'settings',
    SWITCH_WEBVIEW: 'switchWebview',
} as const;

/**
 * QuickPick 视图管理器
 */
export class QuickPickView {
    private lastSnapshot?: QuotaSnapshot;
    private refreshCallback?: () => void;
    private lastRefreshTime: number = 0;

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
     * 显示主菜单
     */
    async show(): Promise<void> {
        if (!this.lastSnapshot) {
            vscode.window.showWarningMessage(t('dashboard.connecting'));
            return;
        }

        const config = configService.getConfig();
        
        if (config.groupingEnabled && this.lastSnapshot.groups) {
            await this.showGroupedView();
        } else {
            await this.showModelView();
        }
    }

    /**
     * 显示非分组模式的模型列表
     */
    private async showModelView(): Promise<void> {
        const pick = vscode.window.createQuickPick<QuotaQuickPickItem>();
        pick.title = t('dashboard.title');
        pick.placeholder = t('quickpick.placeholder');
        pick.matchOnDescription = false;
        pick.matchOnDetail = false;
        pick.canSelectMany = false;

        pick.items = this.buildModelItems();

        // 标题栏按钮
        const config = configService.getConfig();
        pick.buttons = this.buildTitleButtons(config.groupingEnabled);

        let currentActiveItem: QuotaQuickPickItem | undefined;

        pick.onDidChangeActive(items => {
            currentActiveItem = items[0] as QuotaQuickPickItem;
        });

        pick.onDidAccept(async () => {
            if (!currentActiveItem) return;

            // 处理模型置顶切换
            if (currentActiveItem.modelId) {
                const targetModelId = currentActiveItem.modelId;
                await configService.togglePinnedModel(targetModelId);
                
                // 局部刷新
                const config = configService.getConfig();
                const isPinnedNow = config.pinnedModels.some(
                    p => p.toLowerCase() === targetModelId.toLowerCase(),
                );
                
                const currentItems = [...pick.items] as QuotaQuickPickItem[];
                const targetIndex = currentItems.findIndex(item => item.modelId === targetModelId);
                
                if (targetIndex >= 0) {
                    const oldItem = currentItems[targetIndex];
                    const newPinIcon = isPinnedNow ? '$(pinned)' : '$(circle-outline)';
                    const newLabel = oldItem.label.replace(/^\$\((pinned|circle-outline)\)/, newPinIcon);
                    
                    const updatedItem: QuotaQuickPickItem = { ...oldItem, label: newLabel };
                    currentItems[targetIndex] = updatedItem;
                    
                    pick.items = currentItems;
                    pick.activeItems = [updatedItem];
                }
            }
        });

        // 处理按钮点击（重命名/重置）
        pick.onDidTriggerItemButton(async (event) => {
            const item = event.item as QuotaQuickPickItem;
            const button = event.button as IdentifiableButton;
            
            if (!item.modelId) return;

            if (button.id === BUTTON_ID.RENAME) {
                await this.handleRename(pick, item.modelId, item.originalLabel || '', false);
            } else if (button.id === BUTTON_ID.RESET) {
                await this.handleReset(pick, item.modelId, item.originalLabel || '', false);
            }
        });

        // 处理标题栏按钮点击
        pick.onDidTriggerButton(async (button) => {
            const btn = button as IdentifiableButton;
            pick.hide();
            await this.handleTitleButtonClick(btn.id);
        });

        pick.onDidHide(() => pick.dispose());
        pick.show();
    }

    /**
     * 显示分组模式的分组列表
     */
    private async showGroupedView(): Promise<void> {
        const pick = vscode.window.createQuickPick<QuotaQuickPickItem>();
        pick.title = t('dashboard.title') + ' - ' + t('grouping.title');
        pick.placeholder = t('quickpick.placeholderGrouped');
        pick.matchOnDescription = false;
        pick.matchOnDetail = false;
        pick.canSelectMany = false;

        pick.items = this.buildGroupItems();

        // 标题栏按钮
        const config = configService.getConfig();
        pick.buttons = this.buildTitleButtons(config.groupingEnabled);

        let currentActiveItem: QuotaQuickPickItem | undefined;

        pick.onDidChangeActive(items => {
            currentActiveItem = items[0] as QuotaQuickPickItem;
        });

        pick.onDidAccept(async () => {
            if (!currentActiveItem) return;

            // 处理分组置顶切换
            if (currentActiveItem.groupId) {
                const targetGroupId = currentActiveItem.groupId;
                await configService.togglePinnedGroup(targetGroupId);
                
                // 局部刷新
                const config = configService.getConfig();
                const isPinnedNow = config.pinnedGroups.includes(targetGroupId);
                
                const currentItems = [...pick.items] as QuotaQuickPickItem[];
                const targetIndex = currentItems.findIndex(item => item.groupId === targetGroupId);
                
                if (targetIndex >= 0) {
                    const oldItem = currentItems[targetIndex];
                    const newPinIcon = isPinnedNow ? '$(pinned)' : '$(circle-outline)';
                    const newLabel = oldItem.label.replace(/^\$\((pinned|circle-outline)\)/, newPinIcon);
                    
                    const updatedItem: QuotaQuickPickItem = { ...oldItem, label: newLabel };
                    currentItems[targetIndex] = updatedItem;
                    
                    pick.items = currentItems;
                    pick.activeItems = [updatedItem];
                }
            }
        });

        // 处理按钮点击（重命名/重置分组名）
        pick.onDidTriggerItemButton(async (event) => {
            const item = event.item as QuotaQuickPickItem;
            const button = event.button as IdentifiableButton;
            
            if (!item.groupId || !item.groupModelIds) return;

            if (button.id === BUTTON_ID.RENAME) {
                await this.handleGroupRename(pick, item.groupModelIds, item.originalLabel || '');
            } else if (button.id === BUTTON_ID.RESET) {
                await this.handleGroupReset(pick, item.groupModelIds, item.originalLabel || '');
            }
        });

        // 处理标题栏按钮点击
        pick.onDidTriggerButton(async (button) => {
            const btn = button as IdentifiableButton;
            pick.hide();
            await this.handleTitleButtonClick(btn.id);
        });

        pick.onDidHide(() => pick.dispose());
        pick.show();
    }

    /**
     * 构建非分组模式的菜单项
     */
    private buildModelItems(): QuotaQuickPickItem[] {
        const items: QuotaQuickPickItem[] = [];
        const snapshot = this.lastSnapshot;
        const config = configService.getConfig();

        if (snapshot && snapshot.models.length > 0) {
            const pinnedModels = config.pinnedModels;
            const customNames = config.modelCustomNames || {};
            
            const renameButton: IdentifiableButton = {
                iconPath: new vscode.ThemeIcon('edit'),
                tooltip: t('model.rename'),
                id: BUTTON_ID.RENAME,
            };
            const resetButton: IdentifiableButton = {
                iconPath: new vscode.ThemeIcon('discard'),
                tooltip: t('model.reset'),
                id: BUTTON_ID.RESET,
            };

            for (const model of snapshot.models) {
                const pct = model.remainingPercentage ?? 0;
                const bar = this.drawProgressBar(pct);
                const isPinned = pinnedModels.some(
                    p => p.toLowerCase() === model.modelId.toLowerCase(),
                );

                const pinIcon = isPinned ? '$(pinned)' : '$(circle-outline)';
                const displayName = customNames[model.modelId] || model.label;
                const hasCustomName = !!customNames[model.modelId];

                // 计算具体重置时间
                const resetTimeStr = model.resetTime 
                    ? new Date(model.resetTime).toLocaleString('zh-CN', { 
                        year: 'numeric', 
                        month: '2-digit', 
                        day: '2-digit', 
                        hour: '2-digit', 
                        minute: '2-digit',
                        hour12: false 
                      })
                    : '-';
                const countdown = model.timeUntilResetFormatted || '-';

                items.push({
                    label: `${pinIcon} ${displayName}`,
                    description: '',
                    detail: `    ${bar} ${pct.toFixed(1)}% | ${t('dashboard.resetTime')}: ${countdown} (${resetTimeStr})`,
                    modelId: model.modelId,
                    originalLabel: model.label,
                    buttons: hasCustomName ? [renameButton, resetButton] : [renameButton],
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
     * 构建分组模式的菜单项
     */
    private buildGroupItems(): QuotaQuickPickItem[] {
        const items: QuotaQuickPickItem[] = [];
        const snapshot = this.lastSnapshot;
        const config = configService.getConfig();

        if (snapshot && snapshot.groups && snapshot.groups.length > 0) {
            const pinnedGroups = config.pinnedGroups;
            const customNames = config.groupingCustomNames || {};
            
            const renameButton: IdentifiableButton = {
                iconPath: new vscode.ThemeIcon('edit'),
                tooltip: t('grouping.rename'),
                id: BUTTON_ID.RENAME,
            };
            const resetButton: IdentifiableButton = {
                iconPath: new vscode.ThemeIcon('discard'),
                tooltip: t('model.reset'),
                id: BUTTON_ID.RESET,
            };

            for (const group of snapshot.groups) {
                const pct = group.remainingPercentage ?? 0;
                const bar = this.drawProgressBar(pct);
                const isPinned = pinnedGroups.includes(group.groupId);

                const pinIcon = isPinned ? '$(pinned)' : '$(circle-outline)';
                
                // 使用自定义名称（通过锚点共识机制）
                const firstModelId = group.models[0]?.modelId;
                const displayName = (firstModelId && customNames[firstModelId]) || group.groupName;
                const hasCustomName = !!(firstModelId && customNames[firstModelId]);
                
                // 组内模型名称列表
                const modelNames = group.models.map(m => 
                    config.modelCustomNames?.[m.modelId] || m.label
                ).join(', ');

                // 计算具体重置时间（使用分组中第一个模型的重置时间）
                const firstModel = group.models[0];
                const resetTimeStr = firstModel?.resetTime 
                    ? new Date(firstModel.resetTime).toLocaleString('zh-CN', { 
                        year: 'numeric', 
                        month: '2-digit', 
                        day: '2-digit', 
                        hour: '2-digit', 
                        minute: '2-digit',
                        hour12: false 
                      })
                    : '-';
                const countdown = group.timeUntilResetFormatted || firstModel?.timeUntilResetFormatted || '-';

                items.push({
                    label: `${pinIcon} ${displayName}`,
                    description: `(${modelNames})`,
                    detail: `    ${bar} ${pct.toFixed(1)}% | ${t('dashboard.resetTime')}: ${countdown} (${resetTimeStr})`,
                    groupId: group.groupId,
                    groupModelIds: group.models.map(m => m.modelId),
                    originalLabel: group.groupName,
                    buttons: hasCustomName ? [renameButton, resetButton] : [renameButton],
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
     * 处理模型重命名
     */
    private async handleRename(
        pick: vscode.QuickPick<QuotaQuickPickItem>,
        modelId: string,
        originalLabel: string,
        isGroup: boolean,
    ): Promise<void> {
        const config = configService.getConfig();
        const currentName = config.modelCustomNames?.[modelId] || originalLabel;
        
        pick.hide();
        
        const newName = await vscode.window.showInputBox({
            prompt: t('model.renamePrompt'),
            value: currentName,
            placeHolder: originalLabel,
        });
        
        if (newName !== undefined) {
            await configService.updateModelName(modelId, newName);
            
            const displayName = newName.trim() || originalLabel;
            vscode.window.showInformationMessage(t('model.renamed', { name: displayName }));
        }
        
        await this.show();
    }

    /**
     * 处理模型名称重置
     */
    private async handleReset(
        pick: vscode.QuickPick<QuotaQuickPickItem>,
        modelId: string,
        originalLabel: string,
        isGroup: boolean,
    ): Promise<void> {
        await configService.updateModelName(modelId, '');
        vscode.window.showInformationMessage(t('model.renamed', { name: originalLabel }));
        
        // 局部刷新
        pick.items = this.buildModelItems();
    }

    /**
     * 处理分组重命名
     */
    private async handleGroupRename(
        pick: vscode.QuickPick<QuotaQuickPickItem>,
        modelIds: string[],
        originalLabel: string,
    ): Promise<void> {
        const config = configService.getConfig();
        const firstModelId = modelIds[0];
        const currentName = config.groupingCustomNames?.[firstModelId] || originalLabel;
        
        pick.hide();
        
        const newName = await vscode.window.showInputBox({
            prompt: t('grouping.renamePrompt'),
            value: currentName,
            placeHolder: originalLabel,
        });
        
        if (newName !== undefined && newName.trim()) {
            await configService.updateGroupName(modelIds, newName.trim());
            vscode.window.showInformationMessage(t('model.renamed', { name: newName }));
        }
        
        await this.show();
    }

    /**
     * 处理分组名称重置
     */
    private async handleGroupReset(
        pick: vscode.QuickPick<QuotaQuickPickItem>,
        modelIds: string[],
        originalLabel: string,
    ): Promise<void> {
        // 清除所有模型的自定义分组名
        const config = configService.getConfig();
        const customNames = { ...config.groupingCustomNames };
        
        for (const modelId of modelIds) {
            delete customNames[modelId];
        }
        
        await configService.updateConfig('groupingCustomNames', customNames);
        vscode.window.showInformationMessage(t('model.renamed', { name: originalLabel }));
        
        // 刷新视图
        pick.items = this.buildGroupItems();
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
    private async handleAction(
        action: 'openActions' | 'refresh' | 'logs' | 'settings' | 'switchToWebview' | 'toggleGrouping' | 'autoGroup' | 'back',
    ): Promise<void> {
        switch (action) {
            case 'back':
                await this.show();
                break;
                
            case 'refresh': {
                const config = configService.getConfig();
                const cooldownSeconds = config.refreshInterval || 120;
                const now = Date.now();
                const elapsed = Math.floor((now - this.lastRefreshTime) / 1000);
                const remaining = cooldownSeconds - elapsed;
                
                if (remaining > 0) {
                    vscode.window.showWarningMessage(
                        t('quickpick.refreshCooldown', { seconds: remaining }) || `请等待 ${remaining} 秒后再刷新`
                    );
                    await this.show();
                    return;
                }
                
                this.lastRefreshTime = now;
                if (this.refreshCallback) {
                    this.refreshCallback();
                }
                vscode.window.showInformationMessage(t('notify.refreshing'));
                // 刷新后返回主菜单
                setTimeout(() => this.show(), 500);
                break;
            }
                
            case 'logs':
                vscode.commands.executeCommand('agCockpit.showLogs');
                break;
                
            case 'settings':
                vscode.commands.executeCommand('workbench.action.openSettings', 'agCockpit');
                break;
                
            case 'switchToWebview':
                await configService.updateConfig('displayMode', DISPLAY_MODE.WEBVIEW);
                vscode.window.showInformationMessage(t('quickpick.switchedToWebview'));
                vscode.commands.executeCommand('agCockpit.open');
                break;
                
            case 'toggleGrouping': {
                const newValue = await configService.toggleGroupingEnabled();
                const msg = newValue ? t('grouping.enable') : t('grouping.disable');
                vscode.window.showInformationMessage(msg);
                // 触发数据刷新以更新分组信息
                if (this.refreshCallback) {
                    this.refreshCallback();
                }
                setTimeout(() => this.show(), 500);
                break;
            }
                
            case 'autoGroup':
                if (this.lastSnapshot && this.lastSnapshot.models.length > 0) {
                    const newMappings = ReactorCore.calculateGroupMappings(this.lastSnapshot.models);
                    await configService.updateGroupMappings(newMappings);
                    vscode.window.showInformationMessage(
                        `${t('grouping.autoGroup')}: ${Object.keys(newMappings).length} ${t('grouping.models')}`,
                    );
                    // 需要触发数据刷新以更新分组
                    if (this.refreshCallback) {
                        this.refreshCallback();
                    }
                    setTimeout(() => this.show(), 500);
                }
                break;
        }
    }

    /**
     * 构建标题栏按钮
     */
    private buildTitleButtons(isGroupingEnabled: boolean): IdentifiableButton[] {
        const buttons: IdentifiableButton[] = [];

        // 刷新按钮
        buttons.push({
            iconPath: new vscode.ThemeIcon('sync'),
            tooltip: t('dashboard.refresh'),
            id: TITLE_BUTTON_ID.REFRESH,
        });

        // 切换分组按钮
        buttons.push({
            iconPath: new vscode.ThemeIcon(isGroupingEnabled ? 'list-flat' : 'list-tree'),
            tooltip: isGroupingEnabled ? t('grouping.disable') : t('grouping.enable'),
            id: TITLE_BUTTON_ID.TOGGLE_GROUPING,
        });

        // 日志按钮
        buttons.push({
            iconPath: new vscode.ThemeIcon('output'),
            tooltip: t('quickpick.openLogs'),
            id: TITLE_BUTTON_ID.LOGS,
        });

        // 设置按钮
        buttons.push({
            iconPath: new vscode.ThemeIcon('gear'),
            tooltip: t('quickpick.openSettings'),
            id: TITLE_BUTTON_ID.SETTINGS,
        });

        // 切换到 Webview 按钮
        buttons.push({
            iconPath: new vscode.ThemeIcon('browser'),
            tooltip: t('quickpick.switchToWebview'),
            id: TITLE_BUTTON_ID.SWITCH_WEBVIEW,
        });

        // 自动分组按钮（仅分组模式显示，放最后）
        if (isGroupingEnabled) {
            buttons.push({
                iconPath: new vscode.ThemeIcon('sparkle'),
                tooltip: t('grouping.autoGroup'),
                id: TITLE_BUTTON_ID.AUTO_GROUP,
            });
        }

        return buttons;
    }

    /**
     * 处理标题栏按钮点击
     */
    private async handleTitleButtonClick(buttonId: string): Promise<void> {
        switch (buttonId) {
            case TITLE_BUTTON_ID.REFRESH:
                await this.handleAction('refresh');
                break;
            case TITLE_BUTTON_ID.TOGGLE_GROUPING:
                await this.handleAction('toggleGrouping');
                break;
            case TITLE_BUTTON_ID.AUTO_GROUP:
                await this.handleAction('autoGroup');
                break;
            case TITLE_BUTTON_ID.LOGS:
                await this.handleAction('logs');
                break;
            case TITLE_BUTTON_ID.SETTINGS:
                await this.handleAction('settings');
                break;
            case TITLE_BUTTON_ID.SWITCH_WEBVIEW:
                await this.handleAction('switchToWebview');
                break;
        }
    }
}
