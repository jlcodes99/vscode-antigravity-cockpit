/**
 * Antigravity Cockpit - Auto Trigger Controller
 * 自动触发功能的主控制器
 * 整合 OAuth、调度器、触发器，提供统一的接口
 */

import * as vscode from 'vscode';
import { credentialStorage } from './credential_storage';
import { oauthService } from './oauth_service';
import { schedulerService, CronParser } from './scheduler_service';
import { triggerService } from './trigger_service';
import {
    AutoTriggerState,
    ScheduleConfig,
    AutoTriggerMessage,
    SCHEDULE_PRESETS,
} from './types';
import { logger } from '../shared/log_service';
import { t } from '../shared/i18n';
import { DEPRECATED_MODEL_KEY_REPLACEMENTS } from '../shared/model_preference_migration';

/**
 * 带有配额信息的模型（用于配额重置检测）
 */
interface QuotaModelInfo {
    id: string;
    displayName: string;
    modelConstant: string;
    resetTime?: Date;
    remainingFraction?: number;
}

// 存储键
const SCHEDULE_CONFIG_KEY = 'scheduleConfig';
const DEFAULT_AUTO_TRIGGER_MODEL = 'gemini-3-flash';
const TIME_24H_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LEGACY_AUTO_TRIGGER_MODEL_REPLACEMENTS = new Map<string, string>(
    Object.entries(DEPRECATED_MODEL_KEY_REPLACEMENTS).map(([from, to]) => [from.toLowerCase(), to]),
);

/**
 * 自动触发控制器
 */
class AutoTriggerController {
    private initialized = false;
    private messageHandler?: (message: AutoTriggerMessage) => void;
    /** 配额中显示的模型常量列表，用于过滤可用模型 */
    private quotaModelConstants: string[] = [];
    /** 模型 ID 到模型常量的映射 (id -> modelConstant) */
    private modelIdToConstant: Map<string, string> = new Map();
    /** Fallback 定时器列表 (时段外固定时间触发) */
    private fallbackTimers: ReturnType<typeof setTimeout>[] = [];
    /** 账户操作互斥锁，防止并发账户操作导致状态不一致 */
    private accountOperationLock: Promise<void> = Promise.resolve();

    /**
     * 执行账户操作时获取互斥锁
     * 确保同一时间只有一个账户操作（删除、切换、导入等）在执行
     */
    private async withAccountLock<T>(operation: () => Promise<T>): Promise<T> {
        // 等待前一个操作完成
        const previousLock = this.accountOperationLock;
        let releaseLock: () => void;
        this.accountOperationLock = new Promise<void>(resolve => {
            releaseLock = resolve;
        });

        try {
            await previousLock;
            return await operation();
        } finally {
            releaseLock!();
        }
    }

    private createDefaultScheduleConfig(): ScheduleConfig {
        return {
            enabled: false,
            repeatMode: 'daily',
            dailyTimes: ['08:00'],
            weeklyDays: [1, 2, 3, 4, 5],
            weeklyTimes: ['08:00'],
            intervalHours: 4,
            intervalStartTime: '07:00',
            intervalEndTime: '22:00',
            selectedModels: [DEFAULT_AUTO_TRIGGER_MODEL],
            wakeOnReset: false,
            timeWindowEnabled: false,
            timeWindowStart: '09:00',
            timeWindowEnd: '18:00',
            fallbackTimes: ['07:00'],
            maxOutputTokens: 0,
        };
    }

    private normalizeStringArray(values: unknown): string[] {
        if (!Array.isArray(values)) {
            return [];
        }
        const result: string[] = [];
        const seen = new Set<string>();
        for (const value of values) {
            if (typeof value !== 'string') {
                continue;
            }
            const trimmed = value.trim();
            if (!trimmed) {
                continue;
            }
            const key = trimmed.toLowerCase();
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            result.push(trimmed);
        }
        return result;
    }

    private normalizeTimeValue(value: unknown): string | undefined {
        if (typeof value !== 'string') {
            return undefined;
        }
        const trimmed = value.trim();
        return TIME_24H_REGEX.test(trimmed) ? trimmed : undefined;
    }

    private normalizeTimeArray(values: unknown): string[] {
        const normalized: string[] = [];
        const seen = new Set<string>();
        for (const value of this.normalizeStringArray(values)) {
            const time = this.normalizeTimeValue(value);
            if (!time || seen.has(time)) {
                continue;
            }
            seen.add(time);
            normalized.push(time);
        }
        return normalized;
    }

    private normalizeWeekDays(values: unknown): number[] {
        if (!Array.isArray(values)) {
            return [];
        }
        const normalized: number[] = [];
        const seen = new Set<number>();
        for (const value of values) {
            const parsed = typeof value === 'number'
                ? value
                : (typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN);
            if (!Number.isInteger(parsed) || parsed < 0 || parsed > 6 || seen.has(parsed)) {
                continue;
            }
            seen.add(parsed);
            normalized.push(parsed);
        }
        return normalized.sort((a, b) => a - b);
    }

    private normalizeSelectedModels(
        values: unknown,
        availableModelIds?: Set<string>,
    ): string[] {
        const normalized: string[] = [];
        const seen = new Set<string>();

        for (const rawModelId of this.normalizeStringArray(values)) {
            const replacement = LEGACY_AUTO_TRIGGER_MODEL_REPLACEMENTS.get(rawModelId.toLowerCase()) || rawModelId;
            const key = replacement.toLowerCase();
            if (seen.has(key)) {
                continue;
            }
            if (availableModelIds && availableModelIds.size > 0 && !availableModelIds.has(replacement)) {
                continue;
            }
            seen.add(key);
            normalized.push(replacement);
        }

        return normalized;
    }

    private normalizeSelectedAccounts(
        values: unknown,
        availableAccountEmails?: Set<string>,
    ): string[] {
        const normalized: string[] = [];
        const seen = new Set<string>();
        const availableByLower = new Map<string, string>();

        if (availableAccountEmails) {
            for (const email of availableAccountEmails) {
                availableByLower.set(email.toLowerCase(), email);
            }
        }

        for (const rawEmail of this.normalizeStringArray(values)) {
            const key = rawEmail.toLowerCase();
            if (seen.has(key)) {
                continue;
            }
            if (availableByLower.size > 0) {
                const resolved = availableByLower.get(key);
                if (!resolved) {
                    continue;
                }
                seen.add(resolved.toLowerCase());
                normalized.push(resolved);
                continue;
            }
            seen.add(key);
            normalized.push(rawEmail);
        }

        return normalized;
    }

    private normalizeScheduleConfig(
        rawConfig: ScheduleConfig | null | undefined,
        availableModelIds?: Set<string>,
        availableAccountEmails?: Set<string>,
    ): ScheduleConfig {
        const defaults = this.createDefaultScheduleConfig();
        const source: Partial<ScheduleConfig> = rawConfig && typeof rawConfig === 'object'
            ? rawConfig
            : {};

        const normalized: ScheduleConfig = {
            ...defaults,
            dailyTimes: [...(defaults.dailyTimes || [])],
            weeklyDays: [...(defaults.weeklyDays || [])],
            weeklyTimes: [...(defaults.weeklyTimes || [])],
            selectedModels: [...defaults.selectedModels],
            fallbackTimes: [...(defaults.fallbackTimes || [])],
        };

        normalized.enabled = Boolean(source.enabled);

        if (source.repeatMode === 'daily' || source.repeatMode === 'weekly' || source.repeatMode === 'interval') {
            normalized.repeatMode = source.repeatMode;
        }

        const dailyTimes = this.normalizeTimeArray(source.dailyTimes);
        if (dailyTimes.length > 0) {
            normalized.dailyTimes = dailyTimes;
        }

        const weeklyDays = this.normalizeWeekDays(source.weeklyDays);
        if (weeklyDays.length > 0) {
            normalized.weeklyDays = weeklyDays;
        }

        const weeklyTimes = this.normalizeTimeArray(source.weeklyTimes);
        if (weeklyTimes.length > 0) {
            normalized.weeklyTimes = weeklyTimes;
        }

        if (typeof source.intervalHours === 'number' && Number.isFinite(source.intervalHours) && source.intervalHours > 0) {
            normalized.intervalHours = Math.floor(source.intervalHours);
        }

        const intervalStart = this.normalizeTimeValue(source.intervalStartTime);
        if (intervalStart) {
            normalized.intervalStartTime = intervalStart;
        }

        const intervalEnd = this.normalizeTimeValue(source.intervalEndTime);
        if (intervalEnd) {
            normalized.intervalEndTime = intervalEnd;
        }

        if (Array.isArray(source.selectedModels)) {
            normalized.selectedModels = this.normalizeSelectedModels(source.selectedModels, availableModelIds);
        }

        if (Array.isArray(source.selectedAccounts)) {
            normalized.selectedAccounts = this.normalizeSelectedAccounts(source.selectedAccounts, availableAccountEmails);
        } else {
            normalized.selectedAccounts = undefined;
        }

        const crontab = typeof source.crontab === 'string' ? source.crontab.trim() : '';
        normalized.crontab = crontab || undefined;

        normalized.wakeOnReset = Boolean(source.wakeOnReset);
        normalized.timeWindowEnabled = normalized.wakeOnReset && Boolean(source.timeWindowEnabled);

        const timeWindowStart = this.normalizeTimeValue(source.timeWindowStart);
        const timeWindowEnd = this.normalizeTimeValue(source.timeWindowEnd);
        const fallbackTimes = this.normalizeTimeArray(source.fallbackTimes);
        if (normalized.timeWindowEnabled) {
            normalized.timeWindowStart = timeWindowStart || defaults.timeWindowStart;
            normalized.timeWindowEnd = timeWindowEnd || defaults.timeWindowEnd;
            normalized.fallbackTimes = fallbackTimes.length > 0 ? fallbackTimes : [...(defaults.fallbackTimes || [])];
        } else {
            normalized.timeWindowStart = undefined;
            normalized.timeWindowEnd = undefined;
            normalized.fallbackTimes = undefined;
        }

        const customPrompt = typeof source.customPrompt === 'string' ? source.customPrompt.trim() : '';
        normalized.customPrompt = customPrompt || undefined;

        if (typeof source.maxOutputTokens === 'number' && Number.isFinite(source.maxOutputTokens) && source.maxOutputTokens >= 0) {
            normalized.maxOutputTokens = Math.floor(source.maxOutputTokens);
        } else {
            normalized.maxOutputTokens = 0;
        }

        if (!normalized.enabled || normalized.selectedModels.length === 0) {
            normalized.enabled = false;
            normalized.wakeOnReset = false;
            normalized.timeWindowEnabled = false;
            normalized.timeWindowStart = undefined;
            normalized.timeWindowEnd = undefined;
            normalized.fallbackTimes = undefined;
        }

        return normalized;
    }

    private async buildCanonicalScheduleConfig(rawConfig: ScheduleConfig | null | undefined): Promise<ScheduleConfig> {
        let availableModelIds: Set<string> | undefined;
        try {
            const availableModels = await triggerService.fetchAvailableModels(this.quotaModelConstants);
            if (availableModels.length > 0) {
                availableModelIds = new Set(availableModels.map(model => model.id));
            }
        } catch (error) {
            logger.warn(`[AutoTriggerController] Failed to load available models when normalizing schedule: ${error}`);
        }

        const allCredentials = await credentialStorage.getAllCredentials();
        const availableAccountEmails = new Set(Object.keys(allCredentials));

        return this.normalizeScheduleConfig(rawConfig, availableModelIds, availableAccountEmails);
    }


    /**
     * 设置配额模型常量列表（从 Dashboard 的配额数据中获取）
     */
    setQuotaModels(modelConstants: string[]): void {
        this.quotaModelConstants = modelConstants;
        logger.debug(`[AutoTriggerController] Quota model constants set: ${modelConstants.join(', ')}`);
    }

    /**
     * 初始化控制器
     */
    async initialize(context: vscode.ExtensionContext): Promise<void> {
        if (this.initialized) {
            return;
        }

        // 初始化凭证存储
        credentialStorage.initialize(context);

        // 初始化触发服务（加载历史记录）
        triggerService.initialize();

        // 恢复调度配置
        const savedConfig = credentialStorage.getState<ScheduleConfig | null>(SCHEDULE_CONFIG_KEY, null);
        if (savedConfig) {
            const normalizedSavedConfig = await this.buildCanonicalScheduleConfig(savedConfig);
            await credentialStorage.saveState(SCHEDULE_CONFIG_KEY, normalizedSavedConfig);
            // 互斥逻辑：wakeOnReset 优先，不启动定时调度器
            if (normalizedSavedConfig.wakeOnReset && normalizedSavedConfig.enabled) {
                logger.info('[AutoTriggerController] Wake on reset mode enabled, scheduler not started');
                // 如果启用了时段策略且有 fallback 时间，启动 fallback 定时器
                if (normalizedSavedConfig.timeWindowEnabled && normalizedSavedConfig.fallbackTimes?.length) {
                    this.startFallbackScheduler(normalizedSavedConfig);
                }
            } else if (normalizedSavedConfig.enabled) {
                logger.info('[AutoTriggerController] Restoring schedule from saved config');
                schedulerService.setSchedule(normalizedSavedConfig, () => this.executeTrigger());
            }
        }

        this.initialized = true;
        logger.info('[AutoTriggerController] Initialized');
    }

    /**
     * 更新状态栏显示（已整合到主配额悬浮提示中，此方法现为空操作）
     */
    private async updateStatusBar(): Promise<void> {
        // 下次触发时间现在显示在主配额悬浮提示中，不再需要单独的状态栏
    }

    /**
     * 获取当前状态
     */
    async getState(): Promise<AutoTriggerState> {
        const authorization = await credentialStorage.getAuthorizationStatus();
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, this.createDefaultScheduleConfig());

        const nextRunTime = schedulerService.getNextRunTime();
        // 传入配额模型常量进行过滤
        const availableModels = await triggerService.fetchAvailableModels(this.quotaModelConstants);

        // 更新 ID 到常量的映射
        this.modelIdToConstant.clear();
        for (const model of availableModels) {
            if (model.id && model.modelConstant) {
                this.modelIdToConstant.set(model.id, model.modelConstant);
            }
        }
        logger.debug(`[AutoTriggerController] Updated modelIdToConstant mapping: ${this.modelIdToConstant.size} entries`);

        return {
            authorization,
            schedule,
            lastTrigger: triggerService.getLastTrigger(),
            recentTriggers: triggerService.getRecentTriggers(),
            nextTriggerTime: nextRunTime?.toISOString(),
            availableModels,
        };
    }

    /**
     * 开始授权流程
     */
    async startAuthorization(): Promise<boolean> {
        return await oauthService.startAuthorization();
    }

    /**
     * 开始授权流程（别名）
     */
    async authorize(): Promise<boolean> {
        return this.startAuthorization();
    }

    /**
     * 撤销授权
     */
    async revokeAuthorization(): Promise<void> {
        await oauthService.revokeAuthorization();
        // 停止调度器
        schedulerService.stop();
        // 禁用调度
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
            enabled: false,
            repeatMode: 'daily',
            selectedModels: ['gemini-3-flash'],
            maxOutputTokens: 0,
        });
        schedule.enabled = false;
        await credentialStorage.saveState(SCHEDULE_CONFIG_KEY, schedule);
        this.updateStatusBar();
    }

    /**
     * 撤销当前账号授权
     */
    async revokeActiveAccount(): Promise<void> {
        const activeAccount = await credentialStorage.getActiveAccount();
        if (!activeAccount) {
            await this.revokeAuthorization();
            return;
        }
        await this.removeAccount(activeAccount);
    }

    /**
     * 移除指定账号
     * @param email 要移除的账号邮箱
     */
    async removeAccount(email: string): Promise<void> {
        return this.withAccountLock(async () => {
            await oauthService.revokeAccount(email);

            const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
                enabled: false,
                repeatMode: 'daily',
                selectedModels: ['gemini-3-flash'],
                maxOutputTokens: 0,
            });
            const remainingCredentials = await credentialStorage.getAllCredentials();
            const remainingEmails = Object.keys(remainingCredentials);
            const _activeAccount = await credentialStorage.getActiveAccount();
            let scheduleChanged = false;

            if (Array.isArray(schedule.selectedAccounts)) {
                const filtered = schedule.selectedAccounts.filter(account => remainingEmails.includes(account));
                if (filtered.length !== schedule.selectedAccounts.length) {
                    schedule.selectedAccounts = filtered;
                    scheduleChanged = true;

                    // 如果勾选的账号被全部移除，自动关闭自动唤醒
                    if (filtered.length === 0 && schedule.enabled) {
                        schedule.enabled = false;
                        schedulerService.stop();
                        this.stopFallbackScheduler();
                        logger.info('[AutoTriggerController] All selected accounts removed, disabling schedule');
                    }
                }
            }

            // Check if there are remaining accounts
            const hasAuth = await credentialStorage.hasValidCredential();
            if (!hasAuth) {
                // No accounts left, stop scheduler and disable schedule
                schedulerService.stop();
                if (schedule.enabled) {
                    schedule.enabled = false;
                    scheduleChanged = true;
                }
            }

            if (scheduleChanged) {
                await credentialStorage.saveState(SCHEDULE_CONFIG_KEY, schedule);
            }

            this.updateStatusBar();
            this.notifyStateUpdate();
        });
    }

    /**
     * 切换活跃账号
     * @param email 要切换到的账号邮箱
     */
    async switchAccount(email: string): Promise<void> {
        return this.withAccountLock(async () => {
            await credentialStorage.setActiveAccount(email);
            logger.info(`[AutoTriggerController] Switched to account: ${email}`);
            this.notifyStateUpdate();
        });
    }

    /**
     * 重新授权指定账号（先切换到该账号再重新授权）
     * @param email 要重新授权的账号邮箱
     */
    async reauthorizeAccount(email: string): Promise<void> {
        // 先切换到该账号
        await credentialStorage.setActiveAccount(email);
        logger.info(`[AutoTriggerController] Reauthorizing account: ${email}`);
        
        // 执行重新授权流程
        const success = await oauthService.startAuthorization();
        if (!success) {
            throw new Error('Reauthorization cancelled or failed');
        }
        
        this.notifyStateUpdate();
    }

    /**
     * 保存调度配置
     */
    async saveSchedule(config: ScheduleConfig): Promise<void> {
        const normalizedConfig = await this.buildCanonicalScheduleConfig(config);

        // 验证配置
        if (normalizedConfig.crontab) {
            const result = schedulerService.validateCrontab(normalizedConfig.crontab);
            if (!result.valid) {
                throw new Error(`无效的 crontab 表达式: ${result.error}`);
            }
        }

        // 保存配置
        await credentialStorage.saveState(SCHEDULE_CONFIG_KEY, normalizedConfig);

        // 互斥逻辑：三选一
        // 1. wakeOnReset = true → 配额重置触发（不需要定时器）
        // 2. wakeOnReset = false + enabled = true → 定时/Crontab 触发
        // 3. 都为 false → 不触发
        if (normalizedConfig.wakeOnReset && normalizedConfig.enabled) {
            // 配额重置模式：停止定时调度器
            schedulerService.stop();
            this.stopFallbackScheduler();
            logger.info('[AutoTriggerController] Schedule saved, wakeOnReset mode enabled');
            // 如果启用了时段策略且有 fallback 时间，启动 fallback 定时器
            if (normalizedConfig.timeWindowEnabled && normalizedConfig.fallbackTimes?.length) {
                this.startFallbackScheduler(normalizedConfig);
            }
        } else if (normalizedConfig.enabled) {
            // 定时/Crontab 模式
            this.stopFallbackScheduler();
            const accounts = await this.resolveAccountsFromList(normalizedConfig.selectedAccounts);
            if (accounts.length === 0) {
                throw new Error('请先完成授权');
            }
            schedulerService.setSchedule(normalizedConfig, () => this.executeTrigger());
            logger.info(`[AutoTriggerController] Schedule saved, enabled=${normalizedConfig.enabled}`);
        } else {
            // 都不启用
            schedulerService.stop();
            this.stopFallbackScheduler();
            logger.info('[AutoTriggerController] Schedule saved, all triggers disabled');
        }

        this.updateStatusBar();
    }

    /**
     * 解析可用账号列表（多账号）
     */
    private async resolveAccountsFromList(requestedAccounts?: string[]): Promise<string[]> {
        const allCredentials = await credentialStorage.getAllCredentials();
        const allEmails = Object.keys(allCredentials);
        if (allEmails.length === 0) {
            return [];
        }

        // 如果明确传入了账号列表（包括空列表），则严格遵守该列表，不再走备用逻辑。
        // 除非 requestedAccounts 为 undefined (表示从未配置过此项)。
        if (Array.isArray(requestedAccounts)) {
            return requestedAccounts.filter(email => (email in allCredentials) && Boolean(allCredentials[email]?.refreshToken));
        }

        // 备用逻辑：仅在配置缺失时使用。优先使用活跃账号，其次使用第一个可用账号。
        const candidates: string[] = [];
        const active = await credentialStorage.getActiveAccount();
        if (active && (active in allCredentials)) {
            candidates.push(active);
        } else if (allEmails.length > 0) {
            candidates.push(allEmails[0]);
        }

        return candidates.filter(email => Boolean(allCredentials[email]?.refreshToken));
    }

    /**
     * 获取调度触发账号列表（多账号）
     */
    private async resolveScheduleAccounts(schedule: ScheduleConfig): Promise<string[]> {
        return this.resolveAccountsFromList(schedule.selectedAccounts);
    }

    /**
     * 手动触发一次
     * @param models 可选的自定义模型列表
     */
    async testTrigger(models?: string[], accounts?: string[], maxOutputTokens?: number): Promise<void> {
        const targetAccounts = await this.resolveAccountsFromList(accounts);
        if (targetAccounts.length === 0) {
            vscode.window.showErrorMessage(t('autoTrigger.authRequired'));
            return;
        }

        vscode.window.showInformationMessage(t('autoTrigger.triggeringNotify'));

        // 如果传入了自定义模型列表，使用自定义的；否则使用配置中的
        let selectedModels = models;
        if (!selectedModels || selectedModels.length === 0) {
            const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
                enabled: false,
                repeatMode: 'daily',
                selectedModels: ['gemini-3-flash'],
                maxOutputTokens: 0,
            });
            selectedModels = schedule.selectedModels || ['gemini-3-flash'];
        }
        const resolvedMaxOutputTokens = this.resolveMaxOutputTokens(maxOutputTokens);

        let anySuccess = false;
        let totalDuration = 0;
        let firstError: string | undefined;

        for (const email of targetAccounts) {
            const result = await triggerService.trigger(selectedModels, 'manual', undefined, 'manual', email, resolvedMaxOutputTokens);
            totalDuration += result.duration || 0;
            if (result.success) {
                anySuccess = true;
            } else if (!firstError) {
                firstError = result.message;
            }
        }

        if (anySuccess) {
            vscode.window.showInformationMessage(t('autoTrigger.testTriggerSuccess', { duration: totalDuration }));
        } else {
            vscode.window.showErrorMessage(t('autoTrigger.testTriggerFailed', { error: firstError || t('common.unknownError') }));
        }

        // 通知 UI 更新
        this.notifyStateUpdate();
    }

    /**
     * 立即触发（别名，返回结果）
     * @param models 可选的自定义模型列表，如果不传则使用配置中的模型
     * @param customPrompt 可选的自定义唤醒词
     */
    async triggerNow(
        models?: string[],
        customPrompt?: string,
        accounts?: string[],
        maxOutputTokens?: number,
    ): Promise<{ success: boolean; duration?: number; error?: string; response?: string }> {
        const targetAccounts = await this.resolveAccountsFromList(accounts);
        if (targetAccounts.length === 0) {
            return { success: false, error: '请先完成授权' };
        }

        // 如果传入了自定义模型列表，使用自定义的；否则使用配置中的
        let selectedModels = models;
        if (!selectedModels || selectedModels.length === 0) {
            const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
                enabled: false,
                repeatMode: 'daily',
                selectedModels: ['gemini-3-flash'],
                maxOutputTokens: 0,
            });
            selectedModels = schedule.selectedModels || ['gemini-3-flash'];
        }
        const resolvedMaxOutputTokens = this.resolveMaxOutputTokens(maxOutputTokens);

        let anySuccess = false;
        let totalDuration = 0;
        let firstResponse: string | undefined;
        let firstError: string | undefined;

        for (const email of targetAccounts) {
            const result = await triggerService.trigger(selectedModels, 'manual', customPrompt, 'manual', email, resolvedMaxOutputTokens);
            totalDuration += result.duration || 0;
            if (result.success) {
                anySuccess = true;
                if (!firstResponse) {
                    firstResponse = result.message;
                }
            } else if (!firstError) {
                firstError = result.message;
            }
        }

        // 通知 UI 更新
        this.notifyStateUpdate();

        return {
            success: anySuccess,
            duration: totalDuration || undefined,
            error: anySuccess ? undefined : (firstError || 'Unknown error'),
            response: anySuccess ? firstResponse : undefined,  // AI 回复内容
        };
    }

    /**
     * 清空历史记录
     */
    async clearHistory(): Promise<void> {
        triggerService.clearHistory();
        this.notifyStateUpdate();
    }

    /**
     * 执行触发（由调度器调用）
     */
    private async executeTrigger(): Promise<void> {
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
            enabled: false,
            repeatMode: 'daily',
            selectedModels: ['gemini-3-flash'],
            maxOutputTokens: 0,
        });
        const triggerSource = schedule.crontab ? 'crontab' : 'scheduled';
        const accounts = await this.resolveScheduleAccounts(schedule);
        if (accounts.length === 0) {
            logger.warn('[AutoTriggerController] Scheduled trigger skipped: no valid accounts');
            return;
        }

        for (const email of accounts) {
            const result = await triggerService.trigger(
                schedule.selectedModels,
                'auto',
                schedule.customPrompt,
                triggerSource,
                email,
                schedule.maxOutputTokens,
            );

            if (result.success) {
                logger.info(`[AutoTriggerController] Scheduled trigger executed successfully for ${email}`);
            } else {
                logger.error(`[AutoTriggerController] Scheduled trigger failed for ${email}: ${result.message}`);
            }
        }

        // 通知 UI 更新
        this.notifyStateUpdate();
    }

    /**
     * 检查配额重置并自动触发唤醒（多账号独立检测版本）
     * 遍历所有选中账号，为每个账号独立获取配额并检测
     * 由定时刷新或手动触发调用
     */
    async checkAndTriggerOnQuotaReset(): Promise<void> {
        logger.debug('[AutoTriggerController] checkAndTriggerOnQuotaReset called (multi-account)');

        // 获取调度配置
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
            enabled: false,
            repeatMode: 'daily',
            selectedModels: ['gemini-3-flash'],
            maxOutputTokens: 0,
        });

        logger.debug(`[AutoTriggerController] Schedule config: enabled=${schedule.enabled}, wakeOnReset=${schedule.wakeOnReset}, selectedAccounts=${JSON.stringify(schedule.selectedAccounts)}, selectedModels=${JSON.stringify(schedule.selectedModels)}`);

        if (!schedule.enabled) {
            logger.debug('[AutoTriggerController] Wake-up disabled, skipping');
            return;
        }

        // 检查是否启用了"配额重置时自动唤醒"
        if (!schedule.wakeOnReset) {
            logger.debug('[AutoTriggerController] Wake on reset is disabled, skipping');
            return;
        }

        // 检查时段策略
        if (schedule.timeWindowEnabled) {
            const inWindow = this.isInTimeWindow(schedule.timeWindowStart, schedule.timeWindowEnd);
            if (!inWindow) {
                logger.debug('[AutoTriggerController] Outside time window, quota reset trigger skipped (will use fallback times)');
                return;
            }
        }

        // 获取所有选中的账号
        const accounts = await this.resolveScheduleAccounts(schedule);
        if (accounts.length === 0) {
            logger.debug('[AutoTriggerController] Wake on reset: No valid accounts, skipping');
            return;
        }

        const selectedModels = schedule.selectedModels || [];
        if (selectedModels.length === 0) {
            logger.debug('[AutoTriggerController] Wake on reset: No models selected, skipping');
            return;
        }

        logger.info(`[AutoTriggerController] Wake on reset: Checking ${accounts.length} accounts, ${selectedModels.length} models`);

        // 遍历每个选中的账号，独立检测配额
        for (const email of accounts) {
            await this.checkAndTriggerForAccount(email, schedule, selectedModels);
        }
    }

    /**
     * 为单个账号检查配额并触发唤醒
     * @param email 账号邮箱
     * @param schedule 调度配置
     * @param selectedModels 选中的模型列表
     */
    private async checkAndTriggerForAccount(
        email: string,
        schedule: ScheduleConfig,
        selectedModels: string[],
    ): Promise<void> {
        logger.debug(`[AutoTriggerController] Checking quota for account: ${email}`);

        try {
            // 获取该账号的配额数据
            const models = await this.fetchQuotaModelsForAccount(email);
            if (!models || models.length === 0) {
                logger.debug(`[AutoTriggerController] No quota data for ${email}, skipping`);
                return;
            }

            // 构建模型 ID 到配额的映射
            const quotaMap = new Map<string, { id: string; resetAt?: string; remaining: number; limit: number }>();
            for (const model of models) {
                if (!model.modelConstant) {
                    continue;
                }
                const resetAtMs = model.resetTime?.getTime();
                if (!resetAtMs || Number.isNaN(resetAtMs)) {
                    continue;
                }
                
                quotaMap.set(model.modelConstant, {
                    id: model.modelConstant,
                    resetAt: model.resetTime!.toISOString(),
                    remaining: model.remainingFraction !== undefined ? Math.floor(model.remainingFraction * 100) : 0,
                    limit: 100,  // 使用百分比，limit 固定为 100
                });
                // 同时用模型 ID 作为 key
                if (model.id) {
                    quotaMap.set(model.id, quotaMap.get(model.modelConstant)!);
                }
            }

            // 检查每个选中的模型是否需要触发
            const modelsToTrigger: string[] = [];

            for (const modelId of selectedModels) {
                const modelConstant = this.modelIdToConstant.get(modelId);
                const triggerKey = `${email}:${modelConstant || modelId}`;

                // 查找配额数据
                const modelQuota = quotaMap.get(modelConstant || '') || quotaMap.get(modelId);
                if (!modelQuota) {
                    logger.debug(`[AutoTriggerController] Model ${modelId} not found in quota for ${email}`);
                    continue;
                }
                if (!modelQuota.resetAt) {
                    logger.debug(`[AutoTriggerController] Model ${modelId} has no resetAt for ${email}`);
                    continue;
                }

                logger.debug(`[AutoTriggerController] [${email}] Model ${modelId}: remaining=${modelQuota.remaining}%, resetAt=${modelQuota.resetAt}`);

                // 检查是否应该触发 - 使用 email:modelConstant 作为 key 来区分不同账号
                if (triggerService.shouldTriggerOnReset(triggerKey, modelQuota.resetAt, modelQuota.remaining, modelQuota.limit)) {
                    logger.debug(`[AutoTriggerController] [${email}] Model ${modelId} should trigger!`);
                    modelsToTrigger.push(modelId);
                    // 立即标记已触发，防止重复
                    triggerService.markResetTriggered(triggerKey, modelQuota.resetAt);
                } else {
                    logger.debug(`[AutoTriggerController] [${email}] Model ${modelId} should NOT trigger`);
                }
            }

            if (modelsToTrigger.length === 0) {
                logger.debug(`[AutoTriggerController] [${email}] No models to trigger`);
                return;
            }

            // 触发唤醒
            logger.info(`[AutoTriggerController] Wake on reset: Triggering ${email} for models: ${modelsToTrigger.join(', ')}`);
            const result = await triggerService.trigger(
                modelsToTrigger,
                'auto',
                schedule.customPrompt,
                'quota_reset',
                email,
                schedule.maxOutputTokens,
            );

            if (result.success) {
                logger.info(`[AutoTriggerController] Wake on reset: Trigger successful for ${email}`);
            } else {
                logger.error(`[AutoTriggerController] Wake on reset: Trigger failed for ${email}: ${result.message}`);
            }
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            logger.warn(`[AutoTriggerController] Failed to check quota for ${email}: ${error}`);
        }

        // 通知 UI 更新
        this.notifyStateUpdate();
    }

    /**
     * 获取指定账号的配额模型列表
     * @param email 账号邮箱
     * @returns 带有配额信息的模型列表
     */
    private async fetchQuotaModelsForAccount(email: string): Promise<QuotaModelInfo[] | null> {
        try {
            // 获取该账号的 token
            const tokenResult = await oauthService.getAccessTokenStatusForAccount(email);
            if (tokenResult.state !== 'ok' || !tokenResult.token) {
                logger.debug(`[AutoTriggerController] Token unavailable for ${email}: ${tokenResult.state}`);
                return null;
            }

            // 获取 projectId
            const credential = await credentialStorage.getCredentialForAccount(email);
            const projectId = credential?.projectId;

            // 获取配额模型（复用 triggerService 的方法）
            await triggerService.fetchAvailableModels(this.quotaModelConstants);
            
            // 注意：这里需要通过真正的配额 API 获取带有 resetTime 的模型数据
            // 使用 cloudCodeClient 获取完整配额信息
            const { cloudCodeClient } = await import('../shared/cloudcode_client');
            const quotaData = await cloudCodeClient.fetchAvailableModels(
                tokenResult.token,
                projectId,
                { logLabel: 'AutoTriggerController', timeoutMs: 30000 },
            );

            if (!quotaData?.models) {
                return null;
            }

            // 转换为 QuotaModelInfo 格式，包含 resetTime
            const result: QuotaModelInfo[] = [];
            for (const [id, info] of Object.entries(quotaData.models)) {
                const quotaInfo = (info as { quotaInfo?: { remainingFraction?: number; resetTime?: string } }).quotaInfo;
                const resetTimeStr = quotaInfo?.resetTime;
                const resetTime = resetTimeStr ? new Date(resetTimeStr) : undefined;
                const remainingFraction = quotaInfo?.remainingFraction;

                result.push({
                    id,
                    displayName: (info as { displayName?: string }).displayName || id,
                    modelConstant: (info as { model?: string }).model || '',
                    resetTime,
                    remainingFraction,
                });
            }

            logger.debug(`[AutoTriggerController] Fetched ${result.length} models for ${email}`);
            return result;
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            logger.warn(`[AutoTriggerController] Failed to fetch quota models for ${email}: ${error}`);
            return null;
        }
    }

    /**
     * 获取调度描述
     */
    describeSchedule(config: ScheduleConfig): string {
        return schedulerService.describeSchedule(config);
    }

    /**
     * 获取预设模板
     */
    getPresets(): typeof SCHEDULE_PRESETS {
        return SCHEDULE_PRESETS;
    }

    /**
     * 将配置转换为 crontab
     */
    configToCrontab(config: ScheduleConfig): string {
        return schedulerService.configToCrontab(config);
    }

    /**
     * 验证 crontab
     */
    validateCrontab(crontab: string): { valid: boolean; description?: string; error?: string } {
        const result = CronParser.parse(crontab);
        return {
            valid: result.valid,
            description: result.description,
            error: result.error,
        };
    }

    /**
     * 获取下次运行时间的格式化字符串
     */
    getNextRunTimeFormatted(): string | null {
        const nextRun = schedulerService.getNextRunTime();
        if (!nextRun) {
            return null;
        }

        const now = new Date();
        const diff = nextRun.getTime() - now.getTime();

        if (diff < 0) {
            return null;
        }

        // 如果是今天，显示时间
        if (nextRun.toDateString() === now.toDateString()) {
            return nextRun.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        }

        // 如果是明天，显示 "明天 HH:MM"
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (nextRun.toDateString() === tomorrow.toDateString()) {
            return `${t('common.tomorrow')} ${nextRun.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
        }

        // 其他情况显示日期和时间
        return nextRun.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    /**
     * 处理来自 Webview 的消息
     */
    async handleMessage(message: AutoTriggerMessage): Promise<void> {
        switch (message.type) {
            case 'auto_trigger_get_state':
                this.notifyStateUpdate();
                break;

            case 'auto_trigger_start_auth':
                await this.startAuthorization();
                this.notifyStateUpdate();
                break;

            case 'auto_trigger_revoke_auth':
                await this.revokeAuthorization();
                this.notifyStateUpdate();
                break;

            case 'auto_trigger_save_schedule':
                try {
                    await this.saveSchedule(message.data as unknown as ScheduleConfig);
                    this.notifyStateUpdate();
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    vscode.window.showErrorMessage(err.message);
                }
                break;

            case 'auto_trigger_test_trigger':
                await this.testTrigger(
                    message.data?.models,
                    message.data?.accounts as string[] | undefined,
                    message.data?.maxOutputTokens as number | undefined,
                );
                break;

            default:
                logger.warn(`[AutoTriggerController] Unknown message type: ${message.type}`);
        }
    }

    /**
     * 设置消息处理器（用于向 Webview 发送更新）
     */
    setMessageHandler(handler: (message: AutoTriggerMessage) => void): void {
        this.messageHandler = handler;
    }

    /**
     * 通知状态更新
     */
    private async notifyStateUpdate(): Promise<void> {
        // 更新状态栏
        this.updateStatusBar();

        if (this.messageHandler) {
            const state = await this.getState();
            this.messageHandler({
                type: 'auto_trigger_state_update',
                data: state as unknown as Record<string, unknown>,
            });
        }
    }

    /**
     * 判断当前时间是否在指定的时间窗口内
     * @param startTime 开始时间 (如 "09:00")
     * @param endTime 结束时间 (如 "18:00")
     * @returns true 如果在窗口内
     */
    private isInTimeWindow(startTime?: string, endTime?: string): boolean {
        if (!startTime || !endTime) {
            return true; // 未配置时默认在窗口内
        }

        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        const parseTime = (timeStr: string): number => {
            const [h, m] = timeStr.split(':').map(Number);
            return h * 60 + m;
        };

        const startMinutes = parseTime(startTime);
        const endMinutes = parseTime(endTime);

        // 处理跨天情况 (如 22:00 - 06:00)
        if (startMinutes <= endMinutes) {
            // 正常情况: 09:00 - 18:00
            return currentMinutes >= startMinutes && currentMinutes < endMinutes;
        } else {
            // 跨天情况: 22:00 - 06:00
            return currentMinutes >= startMinutes || currentMinutes < endMinutes;
        }
    }

    /**
     * 启动 fallback 定时器（在时段外的固定时间点触发）
     */
    private startFallbackScheduler(config: ScheduleConfig): void {
        this.stopFallbackScheduler();

        const fallbackTimes = config.fallbackTimes || [];
        if (fallbackTimes.length === 0) {
            return;
        }

        logger.info(`[AutoTriggerController] Starting fallback scheduler with times: ${fallbackTimes.join(', ')}`);

        const scheduleNextFallback = () => {
            const now = new Date();
            const currentMinutes = now.getHours() * 60 + now.getMinutes();

            // 找到下一个触发时间点
            const parseTime = (timeStr: string): number => {
                const [h, m] = timeStr.split(':').map(Number);
                return h * 60 + m;
            };

            const times = fallbackTimes.map(t => parseTime(t)).sort((a, b) => a - b);
            let nextTime = times.find(t => t > currentMinutes);

            // 如果今天没有更多时间点，取明天第一个
            const isNextDay = nextTime === undefined;
            if (isNextDay) {
                nextTime = times[0];
            }

            // 如果还是没有时间点，退出
            if (nextTime === undefined) {
                logger.warn('[AutoTriggerController] No fallback times available');
                return;
            }

            // 计算延迟毫秒数
            let delayMinutes = nextTime - currentMinutes;
            if (isNextDay) {
                delayMinutes += 24 * 60;
            }
            const delayMs = delayMinutes * 60 * 1000;

            logger.info(`[AutoTriggerController] Next fallback trigger in ${delayMinutes} minutes (${(nextTime / 60) | 0}:${String(nextTime % 60).padStart(2, '0')})`);

            const timer = setTimeout(async () => {
                // 再次检查是否仍然在时段外
                if (config.timeWindowEnabled) {
                    const inWindow = this.isInTimeWindow(config.timeWindowStart, config.timeWindowEnd);
                    if (inWindow) {
                        logger.info('[AutoTriggerController] Fallback trigger skipped: now inside time window');
                        scheduleNextFallback();
                        return;
                    }
                }

                logger.info('[AutoTriggerController] Fallback trigger firing');
                await this.executeFallbackTrigger(config);
                scheduleNextFallback();
            }, delayMs);

            this.fallbackTimers.push(timer);
        };

        scheduleNextFallback();
    }

    /**
     * 停止所有 fallback 定时器
     */
    private stopFallbackScheduler(): void {
        for (const timer of this.fallbackTimers) {
            clearTimeout(timer);
        }
        this.fallbackTimers = [];
        logger.debug('[AutoTriggerController] Fallback scheduler stopped');
    }

    /**
     * 执行 fallback 触发
     */
    private async executeFallbackTrigger(config: ScheduleConfig): Promise<void> {
        const accounts = await this.resolveAccountsFromList(config.selectedAccounts);
        if (accounts.length === 0) {
            logger.warn('[AutoTriggerController] Fallback trigger skipped: no valid accounts');
            return;
        }

        const selectedModels = config.selectedModels || ['gemini-3-flash'];
        for (const email of accounts) {
            const result = await triggerService.trigger(
                selectedModels,
                'auto',
                config.customPrompt,
                'scheduled', // 标记为 scheduled 类型
                email,
                config.maxOutputTokens,
            );

            if (result.success) {
                logger.info(`[AutoTriggerController] Fallback trigger successful for ${email}`);
            } else {
                logger.error(`[AutoTriggerController] Fallback trigger failed for ${email}: ${result.message}`);
            }
        }

        this.notifyStateUpdate();
    }

    private resolveMaxOutputTokens(maxOutputTokens?: number): number {
        if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
            return Math.floor(maxOutputTokens);
        }
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
            enabled: false,
            repeatMode: 'daily',
            selectedModels: ['gemini-3-flash'],
            maxOutputTokens: 0,
        });
        // 0 means no limit, so return it directly
        return typeof schedule.maxOutputTokens === 'number' && schedule.maxOutputTokens >= 0
            ? Math.floor(schedule.maxOutputTokens)
            : 0;
    }

    /**
     * 启动时自动同步到客户端当前登录账户
     * 优先检测本地 Antigravity 客户端，其次检测 Antigravity Tools：
     * - 如果客户端账户已存在于 Cockpit，自动切换
     * - 如果账户不存在，静默跳过（不弹框打扰用户）
     * @returns 切换结果：'switched' 已切换, 'same' 已是当前账户, 'not_found' 未检测到账户, 'not_exists' 账户未导入
     */
    async syncToClientAccountOnStartup(): Promise<'switched' | 'same' | 'not_found' | 'not_exists'> {
        return this.withAccountLock(async () => {
            try {
                let currentEmail: string | null = null;
                const source = 'local' as const;
                
                // 动态导入，避免循环依赖
                const { previewLocalCredential } = await import('./local_auth_importer');
                
                // 仅检测本地 Antigravity 客户端读取当前账户
                try {
                    const preview = await previewLocalCredential();
                    if (preview?.email) {
                        currentEmail = preview.email;
                        logger.debug(`[AutoTriggerController] Startup sync: found local client account: ${currentEmail}`);
                    }
                } catch (localErr) {
                    logger.debug(`[AutoTriggerController] Startup sync: local client detection failed: ${localErr instanceof Error ? localErr.message : localErr}`);
                }
                
                if (!currentEmail) {
                    logger.debug('[AutoTriggerController] Startup sync: no local client account detected');
                    return 'not_found';
                }

                const activeEmail = await credentialStorage.getActiveAccount();
                const currentEmailLower = currentEmail.toLowerCase();
                
                // 检查是否已是当前账户
                if (activeEmail && activeEmail.toLowerCase() === currentEmailLower) {
                    logger.debug(`[AutoTriggerController] Startup sync: already using account ${activeEmail}`);
                    return 'same';
                }

                // 检查账户是否已存在于 Cockpit
                const accounts = await credentialStorage.getAllCredentials();
                const existingEmail = Object.keys(accounts).find(
                    email => email.toLowerCase() === currentEmailLower,
                );

                if (existingEmail) {
                    // 账户已存在，直接切换
                    logger.info(`[AutoTriggerController] Startup sync: switching to existing account: ${existingEmail} (source: ${source})`);
                    await credentialStorage.setActiveAccount(existingEmail);
                    this.notifyStateUpdate();
                    return 'switched';
                } else {
                    // 账户不存在，静默导入并切换
                    logger.info(`[AutoTriggerController] Startup sync: account ${currentEmail} not found, importing silently...`);
                    try {
                        const { importLocalCredential } = await import('./local_auth_importer');
                        const result = await importLocalCredential();
                        if (result?.email) {
                            logger.info(`[AutoTriggerController] Startup sync: imported and switched to ${result.email}`);
                            this.notifyStateUpdate();
                            return 'switched';
                        }
                    } catch (importErr) {
                        logger.warn(`[AutoTriggerController] Startup sync: silent import failed: ${importErr instanceof Error ? importErr.message : importErr}`);
                    }
                    return 'not_exists';
                }
            } catch (error) {
                const err = error instanceof Error ? error.message : String(error);
                logger.warn(`[AutoTriggerController] Startup sync failed: ${err}`);
                return 'not_found';
            }
        });
    }

    /**
     * 销毁控制器
     */
    dispose(): void {
        schedulerService.stop();
        this.stopFallbackScheduler();
        logger.info('[AutoTriggerController] Disposed');
    }
}

// 导出单例
export const autoTriggerController = new AutoTriggerController();
