/**
 * Antigravity Cockpit - Auto Trigger Types
 * 自动触发功能的类型定义
 */

/**
 * OAuth 凭证数据
 */
export interface OAuthCredential {
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: string;  // ISO 8601 格式
    projectId?: string;
    scopes: string[];
    email?: string;
    /** True if refresh token is invalid (marked when refresh fails) */
    isInvalid?: boolean;
}

/**
 * Account info for UI display (multi-account support)
 */
export interface AccountInfo {
    email: string;
    isActive: boolean;
    expiresAt?: string;
    /** True if refresh token is invalid (marked when refresh fails) */
    isInvalid?: boolean;
}

/**
 * 授权状态 (supports multiple accounts)
 */
export interface AuthorizationStatus {
    isAuthorized: boolean;
    email?: string;
    expiresAt?: string;
    lastRefresh?: string;
    /** All authorized accounts */
    accounts?: AccountInfo[];
    /** Currently active account email */
    activeAccount?: string;
}

/**
 * 调度重复模式
 */
export type ScheduleRepeatMode = 'daily' | 'weekly' | 'interval';

/**
 * 星期几
 */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;  // 0 = Sunday

/**
 * 调度配置
 */
export interface ScheduleConfig {
    enabled: boolean;
    repeatMode: ScheduleRepeatMode;

    // 每天模式
    dailyTimes?: string[];  // ["07:00", "12:00", "17:00"]

    // 每周模式
    weeklyDays?: number[];  // [1, 2, 3, 4, 5] = 工作日 (0 = Sunday)
    weeklyTimes?: string[];

    // 间隔模式
    intervalHours?: number;
    intervalStartTime?: string;  // "07:00"
    intervalEndTime?: string;    // "22:00" (可选，不填则全天)

    // 高级: 原始 crontab 表达式
    crontab?: string;

    /** 选中的模型列表 (用于触发) */
    selectedModels: string[];

    /** 选中的账号列表（用于自动唤醒，多账号） */
    selectedAccounts?: string[];

    /** 配额重置时自动唤醒 */
    wakeOnReset?: boolean;

    /** 自定义唤醒词 (默认: "hi") */
    customPrompt?: string;
}

/**
 * 触发记录
 */
export interface TriggerRecord {
    timestamp: string;  // ISO 8601
    success: boolean;
    prompt?: string;    // 发送的请求内容
    message?: string;   // AI 的回复
    duration?: number;  // ms
    totalTokens?: number; // 消耗的 token（总数）
    promptTokens?: number; // 提示词 token
    completionTokens?: number; // 生成 token
    traceId?: string; // 请求 traceId
    triggerType?: 'manual' | 'auto'; // 触发类型：手动测试 | 自动触发
    triggerSource?: 'manual' | 'scheduled' | 'crontab' | 'quota_reset'; // 自动触发来源
    accountEmail?: string; // 触发账号
}

/**
 * 模型信息（用于自动触发）
 */
export interface ModelInfo {
    /** 模型 ID (用于 API 调用，如 gemini-3-pro-high) */
    id: string;
    /** 显示名称 (如 Gemini 3 Pro (High)) */
    displayName: string;
    /** 模型常量 (用于与配额匹配，如 MODEL_PLACEHOLDER_M8) */
    modelConstant: string;
}

/**
 * 自动触发状态
 */
export interface AutoTriggerState {
    authorization: AuthorizationStatus;
    schedule: ScheduleConfig;
    lastTrigger?: TriggerRecord;
    recentTriggers: TriggerRecord[];  // 最近 10 条
    nextTriggerTime?: string;  // ISO 8601
    /** 可选的模型列表（已过滤，只包含配额中显示的模型） */
    availableModels: ModelInfo[];
}

/**
 * Webview 消息类型
 */
export interface AutoTriggerMessage {
    type:
    | 'auto_trigger_get_state'
    | 'auto_trigger_start_auth'
    | 'auto_trigger_revoke_auth'
    | 'auto_trigger_save_schedule'
    | 'auto_trigger_test_trigger'
    | 'auto_trigger_state_update';
    data?: {
        models?: string[];
        [key: string]: unknown;
    };
}

/**
 * Crontab 解析结果
 */
export interface CrontabParseResult {
    valid: boolean;
    description?: string;  // 人类可读描述
    nextRuns?: Date[];     // 接下来几次运行时间
    error?: string;
}

/**
 * 预设调度模板
 */
export interface SchedulePreset {
    id: string;
    name: string;
    description: string;
    config: Partial<ScheduleConfig>;
}

/**
 * 预设调度模板列表
 */
export const SCHEDULE_PRESETS: SchedulePreset[] = [
    {
        id: 'morning',
        name: '早间预触发',
        description: '每天早上 7:00 触发一次',
        config: {
            repeatMode: 'daily',
            dailyTimes: ['07:00'],
            selectedModels: ['gemini-3-flash'],
        },
    },
    {
        id: 'workday',
        name: '工作日预触发',
        description: '工作日早上 8:00 触发',
        config: {
            repeatMode: 'weekly',
            weeklyDays: [1, 2, 3, 4, 5],
            weeklyTimes: ['08:00'],
            selectedModels: ['gemini-3-flash'],
        },
    },
    {
        id: 'every4h',
        name: '每 4 小时触发',
        description: '从 7:00 开始，每 4 小时触发一次',
        config: {
            repeatMode: 'interval',
            intervalHours: 4,
            intervalStartTime: '07:00',
            intervalEndTime: '23:00',
            selectedModels: ['gemini-3-flash'],
        },
    },
];
