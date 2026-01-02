/**
 * Antigravity Cockpit - Scheduler Service
 * 调度服务：解析 cron 表达式、计算下次运行时间、管理定时任务
 */

import { ScheduleConfig, ScheduleRepeatMode, DayOfWeek, CrontabParseResult } from './types';
import { CronExpressionParser } from 'cron-parser';
import { logger } from '../shared/log_service';

const MAX_TIMER_DELAY_MS = 2_147_483_647; // setTimeout 最大延迟约 24.8 天
const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * Cron 表达式解析器
 * 支持标准 5 字段格式: 分钟 小时 日 月 星期
 */
class CronParser {
    /**
     * 将可视化配置转换为 crontab 表达式
     */
    static configToCrontab(config: ScheduleConfig): string {
        switch (config.repeatMode) {
            case 'daily':
                return this.dailyToCrontab(config.dailyTimes || []);
            case 'weekly':
                return this.weeklyToCrontab(config.weeklyDays || [], config.weeklyTimes || []);
            case 'interval':
                return this.intervalToCrontab(
                    config.intervalHours || 4,
                    config.intervalStartTime || '00:00',
                    config.intervalEndTime
                );
            default:
                return '0 8 * * *'; // 默认每天 8:00
        }
    }

    /**
     * 每天模式转 crontab
     * 例如: ["07:00", "12:00", "17:00"] -> "0 7,12,17 * * *"
     */
    private static dailyToCrontab(times: string[]): string {
        if (times.length === 0) {
            return '0 8 * * *';
        }

        const hours = new Set<number>();
        const minutes = new Set<number>();

        for (const time of times) {
            const [h, m] = time.split(':').map(Number);
            hours.add(h);
            minutes.add(m);
        }

        // 如果所有时间的分钟相同，用简单格式
        if (minutes.size === 1) {
            const minute = Array.from(minutes)[0];
            const hourList = Array.from(hours).sort((a, b) => a - b).join(',');
            return `${minute} ${hourList} * * *`;
        }

        // 否则需要多条表达式（返回第一个时间点的表达式）
        const [h, m] = times[0].split(':').map(Number);
        return `${m} ${h} * * *`;
    }

    /**
     * 每周模式转 crontab
     * 例如: days=[1,2,3,4,5], times=["08:00"] -> "0 8 * * 1-5"
     */
    private static weeklyToCrontab(days: number[], times: string[]): string {
        if (days.length === 0 || times.length === 0) {
            return '0 8 * * 1-5';
        }

        const sortedDays = [...days].sort((a, b) => a - b);
        let dayExpr: string;

        // 检查是否是连续的
        if (this.isConsecutive(sortedDays)) {
            dayExpr = `${sortedDays[0]}-${sortedDays[sortedDays.length - 1]}`;
        } else {
            dayExpr = sortedDays.join(',');
        }

        const [h, m] = times[0].split(':').map(Number);
        return `${m} ${h} * * ${dayExpr}`;
    }

    /**
     * 间隔模式转 crontab
     * 例如: interval=4, start="07:00", end="23:00" -> "0 7,11,15,19,23 * * *"
     */
    private static intervalToCrontab(
        intervalHours: number,
        startTime: string,
        endTime?: string
    ): string {
        const [startH, startM] = startTime.split(':').map(Number);
        const endH = endTime ? parseInt(endTime.split(':')[0], 10) : 23;

        const hours: number[] = [];
        for (let h = startH; h <= endH; h += intervalHours) {
            hours.push(h);
        }

        if (hours.length === 0) {
            hours.push(startH);
        }

        return `${startM} ${hours.join(',')} * * *`;
    }

    /**
     * 检查数组是否连续
     */
    private static isConsecutive(arr: number[]): boolean {
        if (arr.length <= 1) return true;
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] !== arr[i - 1] + 1) {
                return false;
            }
        }
        return true;
    }

    /**
     * 解析 crontab 表达式
     */
    static parse(crontab: string): CrontabParseResult {
        try {
            const parts = crontab.trim().split(/\s+/);
            if (parts.length !== 5) {
                return {
                    valid: false,
                    error: '无效的 crontab 格式，需要 5 个字段',
                };
            }

            const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

            // 生成人类可读描述
            const description = this.generateDescription(minute, hour, dayOfMonth, month, dayOfWeek);

            const interval = CronExpressionParser.parse(crontab, {
                currentDate: new Date(),
                tz: LOCAL_TIMEZONE,
            });
            const nextRuns: Date[] = [];
            for (let i = 0; i < 5; i++) {
                nextRuns.push(interval.next().toDate());
            }

            return {
                valid: true,
                description,
                nextRuns,
            };
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            return {
                valid: false,
                error: err.message,
            };
        }
    }

    /**
     * 生成人类可读描述
     */
    private static generateDescription(
        minute: string,
        hour: string,
        dayOfMonth: string,
        month: string,
        dayOfWeek: string
    ): string {
        if (dayOfMonth !== '*' || month !== '*') {
            return '自定义调度';
        }

        if (minute.includes('/') || hour.includes('/') || dayOfWeek.includes('/')) {
            return '自定义调度';
        }

        const parts: string[] = [];

        // 时间描述
        if (minute === '0' && hour === '*') {
            parts.push('每小时整点');
        } else if (minute.includes(',') && hour.includes(',')) {
            parts.push(`每天 ${hour.replace(',', ', ')} 点 ${minute} 分`);
        } else if (hour.includes(',')) {
            parts.push(`每天 ${hour.split(',').map(h => `${h}:${minute.padStart(2, '0')}`).join(', ')}`);
        } else if (hour !== '*' && minute !== '*') {
            parts.push(`每天 ${hour}:${minute.padStart(2, '0')}`);
        }

        // 星期描述
        if (dayOfWeek !== '*') {
            const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            if (dayOfWeek === '1-5') {
                parts.push('工作日');
            } else if (dayOfWeek === '0,6' || dayOfWeek === '6,0') {
                parts.push('周末');
            } else {
                const days = this.expandField(dayOfWeek, 0, 6).map(d => dayNames[d]);
                parts.push(days.join(', '));
            }
        }

        return parts.join(' ') || '自定义调度';
    }

    /**
     * 展开 cron 字段为数字数组
     */
    private static expandField(field: string, min: number, max: number): number[] {
        if (field === '*') {
            return Array.from({ length: max - min + 1 }, (_, i) => min + i);
        }

        const result: number[] = [];

        for (const part of field.split(',')) {
            if (part.includes('-')) {
                const [start, end] = part.split('-').map(Number);
                for (let i = start; i <= end; i++) {
                    result.push(i);
                }
            } else if (part.startsWith('*/')) {
                const step = parseInt(part.slice(2), 10);
                for (let i = min; i <= max; i += step) {
                    result.push(i);
                }
            } else {
                result.push(parseInt(part, 10));
            }
        }

        return [...new Set(result)].sort((a, b) => a - b);
    }

    /**
     * 计算接下来 n 次运行时间
     */
    static getNextRuns(crontab: string, count: number): Date[] {
        try {
            const results: Date[] = [];
            const interval = CronExpressionParser.parse(crontab, {
                currentDate: new Date(),
                tz: LOCAL_TIMEZONE,
            });

            for (let i = 0; i < count; i++) {
                results.push(interval.next().toDate());
            }

            return results;
        } catch {
            return [];
        }
    }
}

/**
 * 调度服务
 */
class SchedulerService {
    private timer?: ReturnType<typeof setTimeout>;
    private schedule?: ScheduleConfig;
    private onTrigger?: () => Promise<void>;

    /**
     * 设置调度配置
     */
    setSchedule(config: ScheduleConfig, onTrigger: () => Promise<void>): void {
        this.schedule = config;
        this.onTrigger = onTrigger;

        if (config.enabled) {
            this.start();
        } else {
            this.stop();
        }
    }

    /**
     * 启动调度器
     */
    start(): void {
        if (!this.schedule || !this.onTrigger) {
            logger.warn('[SchedulerService] Cannot start: no schedule or trigger handler');
            return;
        }

        if (this.timer) {
            logger.info('[SchedulerService] Scheduler already running, restarting...');
            this.stop();
        }

        this.scheduleNextRun();
        logger.info('[SchedulerService] Scheduler started');
    }

    /**
     * 停止调度器
     */
    stop(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        logger.info('[SchedulerService] Scheduler stopped');
    }

    /**
     * 获取下次运行时间
     */
    getNextRunTime(): Date | null {
        if (!this.schedule || !this.schedule.enabled) {
            return null;
        }

        const crontab = this.schedule.crontab || CronParser.configToCrontab(this.schedule);
        const nextRuns = CronParser.getNextRuns(crontab, 1);
        return nextRuns.length > 0 ? nextRuns[0] : null;
    }

    /**
     * 解析配置并返回描述
     */
    describeSchedule(config: ScheduleConfig): string {
        const crontab = config.crontab || CronParser.configToCrontab(config);
        const result = CronParser.parse(crontab);
        return result.description || crontab;
    }

    /**
     * 验证 crontab 表达式
     */
    validateCrontab(crontab: string): CrontabParseResult {
        return CronParser.parse(crontab);
    }

    /**
     * 将配置转换为 crontab
     */
    configToCrontab(config: ScheduleConfig): string {
        return CronParser.configToCrontab(config);
    }

    /**
     * 调度下次运行
     */
    private scheduleNextRun(): void {
        if (!this.schedule || !this.onTrigger) return;

        const nextRun = this.getNextRunTime();
        if (!nextRun) {
            logger.warn('[SchedulerService] No next run time calculated');
            return;
        }

        const delay = nextRun.getTime() - Date.now();
        if (delay < 0) {
            // 如果已经过了，下一分钟重新计算
            this.timer = setTimeout(() => this.scheduleNextRun(), 60000);
            return;
        }

        if (delay > MAX_TIMER_DELAY_MS) {
            logger.info('[SchedulerService] Next run is far in the future; scheduling a checkpoint.');
            this.timer = setTimeout(() => this.scheduleNextRun(), MAX_TIMER_DELAY_MS);
            return;
        }

        logger.info(`[SchedulerService] Next run scheduled at ${nextRun.toLocaleString()} (in ${Math.round(delay / 60000)} minutes)`);

        this.timer = setTimeout(async () => {
            try {
                logger.info('[SchedulerService] Executing scheduled trigger');
                await this.onTrigger!();
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                logger.error(`[SchedulerService] Trigger failed: ${err.message}`);
            }

            // 调度下一次（如果仍然启用）
            if (this.schedule && this.schedule.enabled) {
                this.scheduleNextRun();
            } else {
                logger.info('[SchedulerService] Schedule disabled, stopping loop');
                this.timer = undefined;
            }
        }, delay);
    }
}

// 导出单例和工具类
export const schedulerService = new SchedulerService();
export { CronParser };
