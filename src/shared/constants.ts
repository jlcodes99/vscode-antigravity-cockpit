/**
 * Antigravity Cockpit - 常量定义
 * 集中管理所有硬编码的魔法值
 */

/** 配额健康度默认阈值 */
export const QUOTA_THRESHOLDS = {
    /** 健康状态阈值 (> 50%) */
    HEALTHY: 50,
    /** 警告状态默认阈值 (> 30%) - 黄色 */
    WARNING_DEFAULT: 30,
    /** 危险状态默认阈值 (<= 10%) - 红色 */
    CRITICAL_DEFAULT: 10,
} as const;

/** 反馈链接 */
export const FEEDBACK_URL = 'https://github.com/jlcodes99/vscode-antigravity-cockpit/issues';

/** 时间相关常量 (毫秒) */
export const TIMING = {
    /** 默认刷新间隔 */
    DEFAULT_REFRESH_INTERVAL_MS: 120000,
    /** 进程扫描重试间隔 */
    PROCESS_SCAN_RETRY_MS: 100,
    /** HTTP 请求超时 */
    HTTP_TIMEOUT_MS: 5000,
    /** 进程命令执行超时（增加到 8000ms 以兼容 PowerShell 冷启动） */
    PROCESS_CMD_TIMEOUT_MS: 8000,
    /** 刷新冷却时间 (秒) */
    REFRESH_COOLDOWN_SECONDS: 60,
} as const;

/** UI 相关常量 */
export const UI = {
    /** 状态栏优先级 */
    STATUS_BAR_PRIORITY: 100,
    /** 卡片最小宽度 */
    CARD_MIN_WIDTH: 280,
} as const;

/** 端点路径 */
export const API_ENDPOINTS = {
    GET_USER_STATUS: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
    GET_UNLEASH_DATA: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
} as const;

/** 目标进程名称映射 */
export const PROCESS_NAMES = {
    windows: 'language_server_windows_x64.exe',
    darwin_arm: 'language_server_macos_arm',
    darwin_x64: 'language_server_macos',
    linux: 'language_server_linux',
} as const;

/** 配置键名 */
export const CONFIG_KEYS = {
    REFRESH_INTERVAL: 'refreshInterval',
    SHOW_PROMPT_CREDITS: 'showPromptCredits',
    PINNED_MODELS: 'pinnedModels',
    MODEL_ORDER: 'modelOrder',
    LOG_LEVEL: 'logLevel',
    NOTIFICATION_ENABLED: 'notificationEnabled',
    STATUS_BAR_FORMAT: 'statusBarFormat',
    GROUPING_ENABLED: 'groupingEnabled',
    GROUPING_CUSTOM_NAMES: 'groupingCustomNames',
    GROUPING_SHOW_IN_STATUS_BAR: 'groupingShowInStatusBar',
    PINNED_GROUPS: 'pinnedGroups',
    GROUP_ORDER: 'groupOrder',
    GROUP_MAPPINGS: 'groupMappings',
    WARNING_THRESHOLD: 'warningThreshold',
    CRITICAL_THRESHOLD: 'criticalThreshold',
} as const;

/** 状态栏显示格式 */
export const STATUS_BAR_FORMAT = {
    /** 简洁模式：只显示百分比 */
    COMPACT: 'compact',
    /** 标准模式：显示模型名 + 百分比 */
    STANDARD: 'standard',
    /** 详细模式：显示完整信息 */
    DETAILED: 'detailed',
} as const;

/** 日志级别 */
export const LOG_LEVELS = {
    DEBUG: 'debug',
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error',
} as const;
