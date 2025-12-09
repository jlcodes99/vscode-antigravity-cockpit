/**
 * Antigravity Cockpit - 配置服务
 * 统一管理所有配置的读取和更新
 */

import * as vscode from 'vscode';
import { CONFIG_KEYS, TIMING, LOG_LEVELS, STATUS_BAR_FORMAT } from './constants';

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
        const config = vscode.workspace.getConfiguration(this.configSection);
        await config.update(key, value, target);
    }

    /**
     * 切换置顶模型
     */
    async togglePinnedModel(modelId: string): Promise<string[]> {
        const config = this.getConfig();
        let pinnedModels = [...config.pinnedModels];

        if (pinnedModels.includes(modelId)) {
            pinnedModels = pinnedModels.filter(id => id !== modelId);
        } else {
            pinnedModels.push(modelId);
        }

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
