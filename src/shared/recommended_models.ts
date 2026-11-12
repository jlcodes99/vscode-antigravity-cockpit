export const AUTH_RECOMMENDED_LABELS = [
    'Gemini 3.1 Pro (High)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3 Flash',
    'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
    'Gemini 3 Pro Image',
];

export const AUTH_RECOMMENDED_MODEL_IDS = [
    'MODEL_PLACEHOLDER_M37', // Gemini 3.1 Pro (High)
    'MODEL_PLACEHOLDER_M36', // Gemini 3.1 Pro (Low)
    'MODEL_PLACEHOLDER_M18', // Gemini 3 Flash
    'MODEL_PLACEHOLDER_M35', // Claude Sonnet 4.6 (Thinking)
    'MODEL_PLACEHOLDER_M26', // Claude Opus 4.6 (Thinking)
    'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
    'MODEL_PLACEHOLDER_M9', // Gemini 3 Pro Image
];

// Authorized 模式黑名单（不显示）
export const AUTH_MODEL_BLACKLIST_IDS = [
    'MODEL_CHAT_20706',
    'MODEL_CHAT_23310',
    'MODEL_GOOGLE_GEMINI_2_5_FLASH',
    'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING',
    'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE',
    'MODEL_GOOGLE_GEMINI_2_5_PRO',
    'MODEL_PLACEHOLDER_M19',
    // Tab 自动补全模型（非聊天模型，监控配额无用户意义）
    'MODEL_PLACEHOLDER_M28',
    // 3.8 Flash 的内部路由别名（tiered），无显示名，实际监控走 high/medium/low 三档
    'MODEL_PLACEHOLDER_M322',
];
