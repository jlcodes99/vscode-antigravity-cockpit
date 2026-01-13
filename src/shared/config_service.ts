/**
 * Antigravity Cockpit - 配置服务
 * 统一管理所有配置的读取和更新
 */

import * as vscode from 'vscode';
import { CONFIG_KEYS, TIMING, LOG_LEVELS, STATUS_BAR_FORMAT, QUOTA_THRESHOLDS, DISPLAY_MODE } from './constants';
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
    /** 模型自定义名称映射 (modelId -> displayName) */
    modelCustomNames: Record<string, string>;
    /** 可见模型列表（为空时显示全部） */
    visibleModels: string[];
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
    /** 配额来源 */
    quotaSource: string;
    /** 显示模式 */
    displayMode: string;
    /** 是否隐藏计划详情面板 */
    profileHidden: boolean;
    /** 是否遮罩敏感数据 */
    dataMasked: boolean;
    /** 语言设置（'auto' 跟随 VS Code，或具体语言代码） */
    language: string;
}

/** 配置服务类 */
class ConfigService {
    private readonly configSection = 'agCockpit';
    private configChangeListeners: Array<(config: CockpitConfig) => void> = [];
    private globalState?: vscode.Memento;
    private initialized = false;
    private readonly stateKeys = new Set<keyof CockpitConfig>([
        'groupMappings',
        'groupOrder',
        'modelCustomNames',
        'modelOrder',
        'pinnedModels',
        'pinnedGroups',
        'groupingCustomNames',
        'visibleModels',
        'quotaSource',  // 使用 globalState 存储，避免 VS Code 配置 API 写入失败问题
        'language',     // 语言设置使用 globalState 存储
    ]);
    private static readonly stateKeyPrefix = 'state';
    private static readonly migrationKey = `${ConfigService.stateKeyPrefix}.migratedToGlobalState.v171`;

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
     * 初始化全局状态（用于存储非设置项）
     */
    async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.globalState = context.globalState;
        this.initialized = true;
        await this.migrateSettingsToState();
        await this.cleanupLegacySettings();
    }

    /**
     * 获取完整配置
     */
    getConfig(): CockpitConfig {
        const config = vscode.workspace.getConfiguration(this.configSection);
        
        // quotaSource 使用 globalState 存储
        // 注意：不再回退到 config.get，只在迁移阶段读取一次旧配置，之后完全由 globalState 决定
        // 默认值设为 'local'
        const quotaSourceResolved = this.getStateValue<string>(CONFIG_KEYS.QUOTA_SOURCE, 'local');
        
        return {
            refreshInterval: config.get<number>(CONFIG_KEYS.REFRESH_INTERVAL, TIMING.DEFAULT_REFRESH_INTERVAL_MS / 1000),
            showPromptCredits: config.get<boolean>(CONFIG_KEYS.SHOW_PROMPT_CREDITS, false),
            pinnedModels: this.getStateValue(CONFIG_KEYS.PINNED_MODELS, []),
            modelOrder: this.getStateValue(CONFIG_KEYS.MODEL_ORDER, []),
            modelCustomNames: this.getStateValue(CONFIG_KEYS.MODEL_CUSTOM_NAMES, {}),
            visibleModels: this.getStateValue(CONFIG_KEYS.VISIBLE_MODELS, []),
            logLevel: config.get<string>(CONFIG_KEYS.LOG_LEVEL, LOG_LEVELS.INFO),
            notificationEnabled: config.get<boolean>(CONFIG_KEYS.NOTIFICATION_ENABLED, true),
            statusBarFormat: config.get<string>(CONFIG_KEYS.STATUS_BAR_FORMAT, STATUS_BAR_FORMAT.STANDARD),
            groupingEnabled: config.get<boolean>(CONFIG_KEYS.GROUPING_ENABLED, true),
            groupingCustomNames: this.getStateValue(CONFIG_KEYS.GROUPING_CUSTOM_NAMES, {}),
            groupingShowInStatusBar: config.get<boolean>(CONFIG_KEYS.GROUPING_SHOW_IN_STATUS_BAR, true),
            pinnedGroups: this.getStateValue(CONFIG_KEYS.PINNED_GROUPS, []),
            groupOrder: this.getStateValue(CONFIG_KEYS.GROUP_ORDER, []),
            groupMappings: this.getStateValue(CONFIG_KEYS.GROUP_MAPPINGS, {}),
            warningThreshold: config.get<number>(CONFIG_KEYS.WARNING_THRESHOLD, QUOTA_THRESHOLDS.WARNING_DEFAULT),
            criticalThreshold: config.get<number>(CONFIG_KEYS.CRITICAL_THRESHOLD, QUOTA_THRESHOLDS.CRITICAL_DEFAULT),
            quotaSource: quotaSourceResolved,
            displayMode: config.get<string>(CONFIG_KEYS.DISPLAY_MODE, DISPLAY_MODE.WEBVIEW),
            profileHidden: config.get<boolean>(CONFIG_KEYS.PROFILE_HIDDEN, true),
            dataMasked: config.get<boolean>(CONFIG_KEYS.DATA_MASKED, false),
            language: this.getStateValue<string>(CONFIG_KEYS.LANGUAGE, 'auto'),
        };
    }

    /**
     * 获取刷新间隔（毫秒）
     */
    getRefreshIntervalMs(): number {
        return this.getConfig().refreshInterval * 1000;
    }

    private buildStateKey(key: string): string {
        return `${ConfigService.stateKeyPrefix}.${key}`;
    }

    getStateFlag(key: string, fallback = false): boolean {
        if (!this.globalState) {
            return fallback;
        }
        return this.globalState.get<boolean>(this.buildStateKey(key), fallback);
    }

    async setStateFlag(key: string, value: boolean): Promise<void> {
        if (!this.globalState) {
            return;
        }
        await this.globalState.update(this.buildStateKey(key), value);
    }

    private getStateValue<T>(configKey: string, fallbackValue: T): T {
        if (this.globalState) {
            const stateKey = this.buildStateKey(configKey);
            const stored = this.globalState.get<T>(stateKey);
            if (stored !== undefined) {
                return stored;
            }
        }
        const config = vscode.workspace.getConfiguration(this.configSection);
        return config.get<T>(configKey as keyof CockpitConfig, fallbackValue);
    }

    private isStateKey(key: keyof CockpitConfig): boolean {
        return this.stateKeys.has(key);
    }

    private notifyListeners(): void {
        const newConfig = this.getConfig();
        this.configChangeListeners.forEach(listener => listener(newConfig));
    }

    /**
     * 更新配置项
     */
    async updateConfig<K extends keyof CockpitConfig>(
        key: K, 
        value: CockpitConfig[K], 
        target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global,
    ): Promise<void> {
        if (this.isStateKey(key) && this.globalState) {
            const stateKey = this.buildStateKey(key);
            logger.info(`Updating state '${stateKey}':`, JSON.stringify(value));
            await this.globalState.update(stateKey, value);
            this.notifyListeners();
            return;
        }

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
     * 更新可见模型列表
     */
    async updateVisibleModels(modelIds: string[]): Promise<void> {
        await this.updateConfig('visibleModels', modelIds);
        await this.setStateFlag('visibleModelsInitialized', true);
    }

    /**
     * 重置模型排序（清除自定义排序）
     */
    async resetModelOrder(): Promise<void> {
        await this.updateConfig('modelOrder', []);
    }

    /**
     * 更新模型自定义名称
     * @param modelId 模型 ID
     * @param displayName 新的显示名称
     */
    async updateModelName(modelId: string, displayName: string): Promise<void> {
        const config = this.getConfig();
        const customNames = { ...config.modelCustomNames };
        
        if (displayName.trim()) {
            customNames[modelId] = displayName.trim();
        } else {
            // 如果名称为空，删除自定义名称（恢复原始名称）
            delete customNames[modelId];
        }
        
        logger.info(`Updating model name for ${modelId} to: ${displayName}`);
        await this.updateConfig('modelCustomNames', customNames);
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

    private async migrateSettingsToState(): Promise<void> {
        if (!this.globalState || this.globalState.get<boolean>(ConfigService.migrationKey, false)) {
            return;
        }

        const config = vscode.workspace.getConfiguration(this.configSection);
        const migrations: Array<{
            key: keyof CockpitConfig;
            configKey: string;
            defaultValue: unknown;
        }> = [
            { key: 'groupMappings', configKey: CONFIG_KEYS.GROUP_MAPPINGS, defaultValue: {} },
            { key: 'groupOrder', configKey: CONFIG_KEYS.GROUP_ORDER, defaultValue: [] },
            { key: 'modelCustomNames', configKey: CONFIG_KEYS.MODEL_CUSTOM_NAMES, defaultValue: {} },
            { key: 'modelOrder', configKey: CONFIG_KEYS.MODEL_ORDER, defaultValue: [] },
            { key: 'pinnedModels', configKey: CONFIG_KEYS.PINNED_MODELS, defaultValue: [] },
            { key: 'pinnedGroups', configKey: CONFIG_KEYS.PINNED_GROUPS, defaultValue: [] },
            { key: 'groupingCustomNames', configKey: CONFIG_KEYS.GROUPING_CUSTOM_NAMES, defaultValue: {} },
            { key: 'visibleModels', configKey: CONFIG_KEYS.VISIBLE_MODELS, defaultValue: [] },
            { key: 'quotaSource', configKey: CONFIG_KEYS.QUOTA_SOURCE, defaultValue: 'local' },
        ];

        let migrated = false;
        for (const item of migrations) {
            const value = config.get(item.configKey as keyof CockpitConfig, item.defaultValue as any);
            const hasValue = Array.isArray(value)
                ? value.length > 0
                : value && typeof value === 'object'
                    ? Object.keys(value).length > 0
                    : value !== item.defaultValue;
            if (hasValue) {
                const stateKey = this.buildStateKey(item.configKey);
                await this.globalState.update(stateKey, value);
                migrated = true;
            }
            await this.clearSetting(item.configKey);
        }

        await this.globalState.update(ConfigService.migrationKey, true);
        if (migrated) {
            this.notifyListeners();
        }
    }

    private async cleanupLegacySettings(): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.configSection);
        const keysToClear = [
            CONFIG_KEYS.GROUP_MAPPINGS,
            CONFIG_KEYS.GROUP_ORDER,
            CONFIG_KEYS.MODEL_CUSTOM_NAMES,
            CONFIG_KEYS.MODEL_ORDER,
            CONFIG_KEYS.PINNED_MODELS,
            CONFIG_KEYS.PINNED_GROUPS,
            CONFIG_KEYS.GROUPING_CUSTOM_NAMES,
            CONFIG_KEYS.VISIBLE_MODELS,
            CONFIG_KEYS.QUOTA_SOURCE,
            'viewMode',
            'dashboardViewMode',
            'cardStyle',
            'announcementCacheTTL',
        ];

        for (const key of keysToClear) {
            const inspected = config.inspect(key);
            const hasValue = inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined;
            if (hasValue) {
                await this.clearSetting(key);
            }
        }
    }

    private async clearSetting(configKey: string): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.configSection);
        await config.update(configKey, undefined, vscode.ConfigurationTarget.Global);
        try {
            await config.update(configKey, undefined, vscode.ConfigurationTarget.Workspace);
        } catch {
            // Ignore workspace removal errors when no workspace is open.
        }
    }
}

// 导出单例
export const configService = new ConfigService();
