/**
 * 用户自定义分组：把「模型 → 用户分组」的映射应用到官方分组结果之上。
 *
 * 上游的分组由 Google 官方 quotaSummary / provider 兜底决定，用户只能重命名。
 * 本模块让用户可以自主建组，并把模型放进自己创建的分组：
 * - 被用户映射的模型从官方组中移出，组成 custom:* 用户组
 * - 未被映射的模型保持官方分组不变
 * - 用户组优先于官方组展示，但官方配额窗口（quotaWindows）仍保留在各自组内
 */

import { ModelQuotaInfo, QuotaGroup } from '../shared/types';

/** 用户自定义组 ID 前缀（与官方 official:* / provider:* 区分） */
export const CUSTOM_GROUP_ID_PREFIX = 'custom:';

export interface CustomGroupInput {
    /** modelId → groupId（用户保存的分组映射） */
    groupMappings: Record<string, string>;
    /** modelId → 自定义组名（组名锚点，取组内任一成员的名称） */
    groupNames?: Record<string, string>;
}

export interface CustomGroupSplitResult {
    /** 用户创建的分组（custom:*），按映射首次出现顺序 */
    customGroups: QuotaGroup[];
    /** 应用用户分组后的完整分组列表（用户组在前，保持官方组相对顺序） */
    groups: QuotaGroup[];
}

/**
 * 从模型列表中提取用户自定义分组。
 * @param models 已过滤的可见模型
 * @param input 用户分组配置
 */
export function buildCustomQuotaGroups(
    models: readonly ModelQuotaInfo[],
    input: CustomGroupInput,
): CustomGroupSplitResult {
    const groupMappings = input.groupMappings ?? {};
    if (Object.keys(groupMappings).length === 0) {
        return { customGroups: [], groups: [] };
    }

    const order: string[] = [];
    const buckets = new Map<string, ModelQuotaInfo[]>();

    for (const model of models) {
        const groupId = groupMappings[model.modelId];
        if (!groupId) {
            continue;
        }
        if (!buckets.has(groupId)) {
            buckets.set(groupId, []);
            order.push(groupId);
        }
        buckets.get(groupId)!.push(model);
    }

    if (order.length === 0) {
        return { customGroups: [], groups: [] };
    }

    const customGroups: QuotaGroup[] = order.map((groupId, index) => {
        const groupModels = buckets.get(groupId)!;
        const firstModel = groupModels[0];
        const groupName = resolveCustomGroupName(groupId, groupModels, input.groupNames, index);

        return {
            groupId: groupId.startsWith(CUSTOM_GROUP_ID_PREFIX)
                ? groupId
                : `${CUSTOM_GROUP_ID_PREFIX}${groupId}`,
            groupName,
            models: groupModels,
            remainingPercentage: Math.min(...groupModels.map(m => m.remainingPercentage ?? 0)),
            resetTime: firstModel.resetTime,
            resetTimeDisplay: firstModel.resetTimeDisplay,
            timeUntilResetFormatted: firstModel.timeUntilResetFormatted,
            isExhausted: groupModels.some(m => m.isExhausted),
            providerGroup: 'custom',
        };
    });

    return { customGroups, groups: customGroups };
}

/**
 * 把用户分组应用到官方分组结果之上：
 * 被用户映射的模型从官方组移出，未映射的保持不变。
 */
export function applyCustomGroups(
    officialGroups: readonly QuotaGroup[],
    customGroups: readonly QuotaGroup[],
): QuotaGroup[] {
    if (customGroups.length === 0) {
        return [...officialGroups];
    }

    const customModelIds = new Set<string>();
    for (const group of customGroups) {
        group.models.forEach(m => customModelIds.add(m.modelId));
    }

    const remainingOfficial: QuotaGroup[] = [];
    for (const group of officialGroups) {
        const kept = group.models.filter(m => !customModelIds.has(m.modelId));
        if (kept.length === 0) {
            // 组内模型全部被用户接管，该官方组不再展示
            continue;
        }
        remainingOfficial.push({ ...group, models: kept });
    }

    return [...customGroups, ...remainingOfficial];
}

/** 组名解析：优先取组内成员的自定义名，其次回退到 Group N */
function resolveCustomGroupName(
    groupId: string,
    groupModels: readonly ModelQuotaInfo[],
    groupNames: Record<string, string> | undefined,
    index: number,
): string {
    if (groupNames) {
        for (const model of groupModels) {
            const name = groupNames[model.modelId];
            if (typeof name === 'string' && name.trim().length > 0) {
                return name.trim();
            }
        }
    }
    // groupId 形如 "a_b"（成员 modelId 排序拼接）时无法还原用户输入的名字，回退默认名
    return `Group ${index + 1}`;
}

/**
 * 校验用户分组配置：过滤掉指向不存在模型的映射。
 * 用于保存前清理，避免残留的 modelId 造成"幽灵分组"。
 */
export function pruneGroupMappings(
    groupMappings: Record<string, string>,
    models: readonly ModelQuotaInfo[],
): Record<string, string> {
    const known = new Set(models.map(m => m.modelId));
    const pruned: Record<string, string> = {};
    for (const [modelId, groupId] of Object.entries(groupMappings ?? {})) {
        if (known.has(modelId) && typeof groupId === 'string' && groupId.length > 0) {
            pruned[modelId] = groupId;
        }
    }
    return pruned;
}
