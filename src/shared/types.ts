/**
 * Antigravity Cockpit - 类型定义
 * 完整的类型系统，避免使用 any
 */

// ============ 配额相关类型 ============

/** Prompt Credits 信息 */
export interface PromptCreditsInfo {
    /** 可用积分 */
    available: number;
    /** 每月配额 */
    monthly: number;
    /** 已使用百分比 */
    usedPercentage: number;
    /** 剩余百分比 */
    remainingPercentage: number;
}

/** 模型配额信息 */
export interface ModelQuotaInfo {
    /** 显示标签 */
    label: string;
    /** 模型 ID */
    modelId: string;
    /** 剩余比例 (0-1) */
    remainingFraction?: number;
    /** 剩余百分比 (0-100) */
    remainingPercentage?: number;
    /** 是否已耗尽 */
    isExhausted: boolean;
    /** 重置时间 */
    resetTime: Date;
    /** 距离重置的毫秒数 */
    timeUntilReset: number;
    /** 格式化的重置倒计时 */
    timeUntilResetFormatted: string;
    /** 格式化的重置时间显示 */
    resetTimeDisplay: string;
}

/** 配额分组 - 共享相同配额的模型集合 */
export interface QuotaGroup {
    /** 分组唯一标识 (基于 remainingFraction + resetTime 生成) */
    groupId: string;
    /** 分组名称 (用户自定义或自动生成) */
    groupName: string;
    /** 分组内的模型列表 */
    models: ModelQuotaInfo[];
    /** 共享的剩余百分比 */
    remainingPercentage: number;
    /** 共享的重置时间 */
    resetTime: Date;
    /** 格式化的重置时间显示 */
    resetTimeDisplay: string;
    /** 格式化的重置倒计时 */
    timeUntilResetFormatted: string;
    /** 是否已耗尽 */
    isExhausted: boolean;
}

/** 配额快照 */
export interface QuotaSnapshot {
    /** 时间戳 */
    timestamp: Date;
    /** Prompt Credits */
    promptCredits?: PromptCreditsInfo;
    /** 用户信息 */
    userInfo?: UserInfo;
    /** 模型列表 */
    models: ModelQuotaInfo[];
    /** 配额分组 (开启分组功能时生成) */
    groups?: QuotaGroup[];
    /** 连接状态 */
    isConnected: boolean;
    /** 错误信息 */
    errorMessage?: string;
}

/** 配额健康状态 */
export enum QuotaLevel {
    /** 正常 (> 50%) */
    Normal = 'normal',
    /** 警告 (20-50%) */
    Warning = 'warning',
    /** 危险 (< 20%) */
    Critical = 'critical',
    /** 已耗尽 (0%) */
    Depleted = 'depleted',
}

// ============ API 响应类型 ============

/** 模型或别名 */
export interface ModelOrAlias {
    model: string;
}

/** 配额信息 */
export interface QuotaInfo {
    remainingFraction?: number;
    resetTime: string;
}

/** 客户端模型配置 */
export interface ClientModelConfig {
    label: string;
    modelOrAlias?: ModelOrAlias;
    quotaInfo?: QuotaInfo;
    supportsImages?: boolean;
    isRecommended?: boolean;
    allowedTiers?: string[];
}

/** 团队配置 */
export interface DefaultTeamConfig {
    allowMcpServers?: boolean;
    allowAutoRunCommands?: boolean;
    allowBrowserExperimentalFeatures?: boolean;
    [key: string]: boolean | string | number | undefined;
}

/** 计划信息 */
export interface PlanInfo {
    teamsTier: string;
    planName: string;
    monthlyPromptCredits: number;
    monthlyFlowCredits: number;
    
    // 功能开关
    browserEnabled?: boolean;
    knowledgeBaseEnabled?: boolean;
    canBuyMoreCredits?: boolean;
    hasAutocompleteFastMode?: boolean;
    cascadeWebSearchEnabled?: boolean;
    canGenerateCommitMessages?: boolean;
    hasTabToJump?: boolean;
    allowStickyPremiumModels?: boolean;
    allowPremiumCommandModels?: boolean;
    canCustomizeAppIcon?: boolean;
    cascadeCanAutoRunCommands?: boolean;
    canAllowCascadeInBackground?: boolean;
    
    // 限制配置
    maxNumChatInputTokens?: string | number;
    maxNumPremiumChatMessages?: string | number;
    maxCustomChatInstructionCharacters?: string | number;
    maxNumPinnedContextItems?: string | number;
    maxLocalIndexSize?: string | number;
    monthlyFlexCreditPurchaseAmount?: number;
    
    // 团队配置
    defaultTeamConfig?: DefaultTeamConfig;
    
    /** 扩展字段 - 支持 API 返回的其他属性 */
    [key: string]: string | number | boolean | object | undefined;
}

/** 计划状态 */
export interface PlanStatus {
    planInfo: PlanInfo;
    availablePromptCredits: number;
    availableFlowCredits: number;
}

/** 模型排序分组 */
export interface ModelSortGroup {
    modelLabels: string[];
}

/** 客户端模型排序 */
export interface ClientModelSort {
    name: string;
    groups: ModelSortGroup[];
}

/** Cascade 模型配置数据 */
export interface CascadeModelConfigData {
    clientModelConfigs: ClientModelConfig[];
    clientModelSorts?: ClientModelSort[];
}

/** 用户状态 */
export interface UserStatus {
    name: string;
    email: string;
    planStatus?: PlanStatus;
    cascadeModelConfigData?: CascadeModelConfigData;
    acceptedLatestTermsOfService?: boolean;
    userTier?: {
        name: string;
        id: string;
        description: string;
        upgradeSubscriptionUri?: string;
        upgradeSubscriptionText?: string;
    };
}

/** 服务端用户状态响应 */
export interface ServerUserStatusResponse {
    userStatus: UserStatus;
}

// ============ 进程检测类型 ============

/** 环境扫描结果 */
export interface EnvironmentScanResult {
    /** 扩展端口 */
    extensionPort: number;
    /** 连接端口 */
    connectPort: number;
    /** CSRF Token */
    csrfToken: string;
}

/** 进程信息 */
export interface ProcessInfo {
    /** 进程 ID */
    pid: number;
    /** 扩展端口 */
    extensionPort: number;
    /** CSRF Token */
    csrfToken: string;
}

/** 用户详细信息 */
export interface UserInfo {
    name: string;
    email: string;
    planName: string;
    tier: string;
    browserEnabled: boolean;
    knowledgeBaseEnabled: boolean;
    canBuyMoreCredits: boolean;
    hasAutocompleteFastMode: boolean;
    monthlyPromptCredits: number;
    monthlyFlowCredits: number;
    availablePromptCredits: number;
    availableFlowCredits: number;
    cascadeWebSearchEnabled: boolean;
    canGenerateCommitMessages: boolean;
    allowMcpServers: boolean;
    maxNumChatInputTokens: string;
    tierDescription: string;
    upgradeUri: string;
    upgradeText: string;
    // New fields
    teamsTier: string;
    hasTabToJump: boolean;
    allowStickyPremiumModels: boolean;
    allowPremiumCommandModels: boolean;
    maxNumPremiumChatMessages: string;
    maxCustomChatInstructionCharacters: string;
    maxNumPinnedContextItems: string;
    maxLocalIndexSize: string;
    monthlyFlexCreditPurchaseAmount: number;
    canCustomizeAppIcon: boolean;
    cascadeCanAutoRunCommands: boolean;
    canAllowCascadeInBackground: boolean;
    allowAutoRunCommands: boolean;
    allowBrowserExperimentalFeatures: boolean;
    acceptedLatestTermsOfService: boolean;
    userTierId: string;
}

// ============ UI 相关类型 ============

/** Webview 消息类型 */
export type WebviewMessageType = 
    | 'init'
    | 'refresh'
    | 'togglePin'
    | 'toggleCredits'
    | 'updateOrder'
    | 'resetOrder'
    | 'retry'
    | 'openLogs'
    | 'rerender'
    | 'renameGroup'
    | 'toggleGrouping'
    | 'promptRenameGroup'
    | 'toggleGroupPin'
    | 'updateGroupOrder'
    | 'autoGroup'
    | 'updateThresholds';

/** Webview 消息 */
export interface WebviewMessage {
    command: WebviewMessageType;
    modelId?: string;
    order?: string[];
    /** 分组 ID */
    groupId?: string;
    /** 分组新名称 */
    groupName?: string;
    /** 分组当前名称 (用于 promptRenameGroup) */
    currentName?: string;
    /** 分组内所有模型 ID */
    modelIds?: string[];
    /** 是否启用通知 (updateThresholds) */
    notificationEnabled?: boolean;
    /** 警告阈值 (updateThresholds) */
    warningThreshold?: number;
    /** 危险阈值 (updateThresholds) */
    criticalThreshold?: number;
}

/** Dashboard 配置 */
export interface DashboardConfig {
    /** 是否显示 Prompt Credits */
    showPromptCredits: boolean;
    /** 置顶的模型 */
    pinnedModels: string[];
    /** 模型顺序 */
    modelOrder: string[];
    /** 是否启用分组显示 */
    groupingEnabled: boolean;
    /** 分组自定义名称映射 (modelId -> groupName) */
    groupCustomNames: Record<string, string>;
    /** 是否在状态栏显示分组 */
    groupingShowInStatusBar: boolean;
    /** 置顶的分组 */
    pinnedGroups: string[];
    /** 分组顺序 */
    groupOrder: string[];
    /** 刷新冷却时间（秒） */
    refreshInterval: number;
    /** 是否启用通知 */
    notificationEnabled: boolean;
    /** 警告阈值 (%) */
    warningThreshold?: number;
    /** 危险阈值 (%) */
    criticalThreshold?: number;
    /** 最后成功更新时间 */
    lastSuccessfulUpdate?: Date | null;
}

/** 状态栏更新数据 */
export interface StatusBarUpdate {
    /** 显示文本 */
    text: string;
    /** 工具提示 */
    tooltip: string;
    /** 背景颜色 */
    backgroundColor?: string;
    /** 最低百分比（用于颜色判断） */
    minPercentage: number;
}

// ============ 平台策略类型 ============

/** 平台类型 */
export type PlatformType = 'windows' | 'darwin' | 'linux';

/** 平台策略接口 */
export interface PlatformStrategy {
    /** 获取进程列表命令 */
    getProcessListCommand(processName: string): string;
    /** 解析进程信息 */
    parseProcessInfo(stdout: string): ProcessInfo | null;
    /** 获取端口列表命令 */
    getPortListCommand(pid: number): string;
    /** 解析监听端口 */
    parseListeningPorts(stdout: string): number[];
    /** 获取诊断命令（列出所有相关进程，用于调试） */
    getDiagnosticCommand(): string;
    /** 获取错误信息 */
    getErrorMessages(): {
        processNotFound: string;
        commandNotAvailable: string;
        requirements: string[];
    };
}

// ============ 遗留类型别名（向后兼容） ============

/** @deprecated 使用 ModelQuotaInfo */
export type model_quota_info = ModelQuotaInfo;

/** @deprecated 使用 PromptCreditsInfo */
export type prompt_credits_info = PromptCreditsInfo;

/** @deprecated 使用 QuotaSnapshot */
export type quota_snapshot = QuotaSnapshot;

/** @deprecated 使用 QuotaLevel */
export const quota_level = QuotaLevel;

/** @deprecated 使用 ServerUserStatusResponse */
export type server_user_status_response = ServerUserStatusResponse;

/** @deprecated 使用 EnvironmentScanResult */
export type environment_scan_result = EnvironmentScanResult;
