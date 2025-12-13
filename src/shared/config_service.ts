/**
 * Antigravity Cockpit - 配置服务
 * 统一管理所有配置的读取和更新
 */

import * as vscode from 'vscode';
import { CONFIG_KEYS, TIMING, LOG_LEVELS, STATUS_BAR_FORMAT, QUOTA_THRESHOLDS } from './constants';
import { logger } from './log_service';

/** 配置对象接口 */
export interface CockpitConfig {
    /** 刷新间隔（秒） */
    refreshInterval: number;
    /** 是否显示 Prompt Credits */
    showPromptCredits: boolean;
    /** 置顶的模型列表 */
    pinnedModels: string[];
    /** 模型排序顺序 */
    modelOrder: string[];
    /** 日志级别 */
    logLevel: string;
    /** 是否启用通知 */
    notificationEnabled: boolean;
    /** 状态栏显示格式 */
    statusBarFormat: string;
    /** 是否启用分组显示 */
    groupingEnabled: boolean;
    /** 分组自定义名称映射 (modelId -> groupName) */
    groupingCustomNames: Record<string, string>;
    /** 是否在状态栏显示分组 */
    groupingShowInStatusBar: boolean;
    /** 置顶的分组列表 */
    pinnedGroups: string[];
    /** 分组排序顺序 */
    groupOrder: string[];
    /** 分组映射 (modelId -> groupId) */
    groupMappings: Record<string, string>;
    /** 警告阈值 (%) */
    warningThreshold: number;
    /** 危险阈值 (%) */
    criticalThreshold: number;
}

/** 配置服务类 */
class ConfigService {
    private readonly configSection = 'agCockpit';
    private configChangeListeners: Array<(config: CockpitConfig) => void> = [];

    constructor() {
        // 监听配置变化
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(this.configSection)) {
                const newConfig = this.getConfig();
                this.configChangeListeners.forEach(listener => listener(newConfig));
            }
        });
    }

    /**
     * 获取完整配置
     */
    getConfig(): CockpitConfig {
        const config = vscode.workspace.getConfiguration(this.configSection);
        
        return {
            refreshInterval: config.get<number>(CONFIG_KEYS.REFRESH_INTERVAL, TIMING.DEFAULT_REFRESH_INTERVAL_MS / 1000),
            showPromptCredits: config.get<boolean>(CONFIG_KEYS.SHOW_PROMPT_CREDITS, false),
            pinnedModels: config.get<string[]>(CONFIG_KEYS.PINNED_MODELS, []),
            modelOrder: config.get<string[]>(CONFIG_KEYS.MODEL_ORDER, []),
            logLevel: config.get<string>(CONFIG_KEYS.LOG_LEVEL, LOG_LEVELS.INFO),
            notificationEnabled: config.get<boolean>(CONFIG_KEYS.NOTIFICATION_ENABLED, true),
            statusBarFormat: config.get<string>(CONFIG_KEYS.STATUS_BAR_FORMAT, STATUS_BAR_FORMAT.STANDARD),
            groupingEnabled: config.get<boolean>(CONFIG_KEYS.GROUPING_ENABLED, true),
            groupingCustomNames: config.get<Record<string, string>>(CONFIG_KEYS.GROUPING_CUSTOM_NAMES, {}),
            groupingShowInStatusBar: config.get<boolean>(CONFIG_KEYS.GROUPING_SHOW_IN_STATUS_BAR, true),
            pinnedGroups: config.get<string[]>(CONFIG_KEYS.PINNED_GROUPS, []),
            groupOrder: config.get<string[]>(CONFIG_KEYS.GROUP_ORDER, []),
            groupMappings: config.get<Record<string, string>>(CONFIG_KEYS.GROUP_MAPPINGS, {}),
            warningThreshold: config.get<number>(CONFIG_KEYS.WARNING_THRESHOLD, QUOTA_THRESHOLDS.WARNING_DEFAULT),
            criticalThreshold: config.get<number>(CONFIG_KEYS.CRITICAL_THRESHOLD, QUOTA_THRESHOLDS.CRITICAL_DEFAULT),
        };
    }

    /**
     * 获取刷新间隔（毫秒）
     */
    getRefreshIntervalMs(): number {
        return this.getConfig().refreshInterval * 1000;
    }

    /**
     * 更新配置项
     */
    async updateConfig<K extends keyof CockpitConfig>(
        key: K, 
        value: CockpitConfig[K], 
        target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global,
    ): Promise<void> {
        logger.info(`Updating config '${this.configSection}.${key}':`, JSON.stringify(value));
        const config = vscode.workspace.getConfiguration(this.configSection);
        await config.update(key, value, target);
    }

    /**
     * 切换置顶模型
     */
    async togglePinnedModel(modelId: string): Promise<string[]> {
        logger.info(`Toggling pin state for model: ${modelId}`);
        const config = this.getConfig();
        const pinnedModels = [...config.pinnedModels];

        const existingIndex = pinnedModels.findIndex(
            p => p.toLowerCase() === modelId.toLowerCase(),
        );

        if (existingIndex > -1) {
            logger.info(`Model ${modelId} found at index ${existingIndex}, removing.`);
            pinnedModels.splice(existingIndex, 1);
        } else {
            logger.info(`Model ${modelId} not found, adding.`);
            pinnedModels.push(modelId);
        }

        logger.info(`New pinned models: ${JSON.stringify(pinnedModels)}`);
        await this.updateConfig('pinnedModels', pinnedModels);
        return pinnedModels;
    }

    /**
     * 切换显示 Prompt Credits
     */
    async toggleShowPromptCredits(): Promise<boolean> {
        const config = this.getConfig();
        const newValue = !config.showPromptCredits;
        await this.updateConfig('showPromptCredits', newValue);
        return newValue;
    }

    /**
     * 更新模型顺序
     */
    async updateModelOrder(order: string[]): Promise<void> {
        await this.updateConfig('modelOrder', order);
    }

    /**
     * 重置模型排序（清除自定义排序）
     */
    async resetModelOrder(): Promise<void> {
        await this.updateConfig('modelOrder', []);
    }

    /**
     * 更新分组名称
     * 将分组中所有模型关联到指定名称（锚点共识机制）
     * @param modelIds 分组内的所有模型 ID
     * @param groupName 新的分组名称
     */
    async updateGroupName(modelIds: string[], groupName: string): Promise<void> {
        const config = this.getConfig();
        const customNames = { ...config.groupingCustomNames };
        
        // 将组内所有模型 ID 都关联到该名称
        for (const modelId of modelIds) {
            customNames[modelId] = groupName;
        }
        
        logger.info(`Updating group name for ${modelIds.length} models to: ${groupName}`);
        await this.updateConfig('groupingCustomNames', customNames);
    }

    /**
     * 切换分组显示
     */
    async toggleGroupingEnabled(): Promise<boolean> {
        const config = this.getConfig();
        const newValue = !config.groupingEnabled;
        await this.updateConfig('groupingEnabled', newValue);
        return newValue;
    }

    /**
     * 切换分组状态栏显示
     */
    async toggleGroupingStatusBar(): Promise<boolean> {
        const config = this.getConfig();
        const newValue = !config.groupingShowInStatusBar;
        await this.updateConfig('groupingShowInStatusBar', newValue);
        return newValue;
    }

    /**
     * 切换分组置顶状态
     */
    async togglePinnedGroup(groupId: string): Promise<string[]> {
        logger.info(`Toggling pin state for group: ${groupId}`);
        const config = this.getConfig();
        const pinnedGroups = [...config.pinnedGroups];

        const existingIndex = pinnedGroups.indexOf(groupId);

        if (existingIndex > -1) {
            logger.info(`Group ${groupId} found at index ${existingIndex}, removing.`);
            pinnedGroups.splice(existingIndex, 1);
        } else {
            logger.info(`Group ${groupId} not found, adding.`);
            pinnedGroups.push(groupId);
        }

        logger.info(`New pinned groups: ${JSON.stringify(pinnedGroups)}`);
        await this.updateConfig('pinnedGroups', pinnedGroups);
        return pinnedGroups;
    }

    /**
     * 更新分组顺序
     */
    async updateGroupOrder(order: string[]): Promise<void> {
        await this.updateConfig('groupOrder', order);
    }

    /**
     * 重置分组排序
     */
    async resetGroupOrder(): Promise<void> {
        await this.updateConfig('groupOrder', []);
    }

    /**
     * 更新分组映射 (modelId -> groupId)
     */
    async updateGroupMappings(mappings: Record<string, string>): Promise<void> {
        await this.updateConfig('groupMappings', mappings);
    }

    /**
     * 清除分组映射（触发重新自动分组）
     */
    async clearGroupMappings(): Promise<void> {
        await this.updateConfig('groupMappings', {});
    }

    /**
     * 注册配置变化监听器
     */
    onConfigChange(listener: (config: CockpitConfig) => void): vscode.Disposable {
        this.configChangeListeners.push(listener);
        return {
            dispose: () => {
                const index = this.configChangeListeners.indexOf(listener);
                if (index > -1) {
                    this.configChangeListeners.splice(index, 1);
                }
            },
        };
    }

    /**
     * 检查模型是否被置顶
     */
    isModelPinned(modelId: string): boolean {
        return this.getConfig().pinnedModels.some(
            p => p.toLowerCase() === modelId.toLowerCase(),
        );
    }
}

// 导出单例
export const configService = new ConfigService();
