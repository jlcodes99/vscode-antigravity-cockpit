/**
 * 用户自定义分组的编辑逻辑（webview 与测试共用，纯函数）。
 *
 * 与官方分组（quotaSummary 驱动）并存：用户可以自主建组，并把模型放进自建组。
 * 保存产物是 modelId → groupId 的映射，写入 config.groupMappings。
 */

export interface EditableModel {
    modelId: string;
    label?: string;
    remainingPercentage?: number;
    resetTimeDisplay?: string;
}

export interface EditableGroup {
    /** 内部标识（编辑期间使用，可任意） */
    id: string;
    name: string;
    modelIds: string[];
}

export interface GroupEditState {
    groups: EditableGroup[];
    /** 已知模型（用于挑选成员） */
    allModels: EditableModel[];
}

export const QUOTA_TOLERANCE_PCT = 0.5;

/** 创建空的编辑状态（弹框初始化用） */
export function createGroupState(allModels: readonly EditableModel[]): GroupEditState {
    return { groups: [], allModels: [...allModels] };
}

export interface ModelCompatibility {
    isCompatible: boolean;
    reason: 'quotaMismatch' | 'resetMismatch' | '';
}

/**
 * 判断模型能否加入指定组（配额一致视为同池）。
 * 仅作提示与排序依据，不阻止用户添加。
 */
export function isModelCompatibleWithGroup(
    model: EditableModel,
    group: EditableGroup,
    allModels: readonly EditableModel[],
): ModelCompatibility {
    if (group.modelIds.length === 0) {
        return { isCompatible: true, reason: '' };
    }
    const anchorId = group.modelIds[0];
    const anchor = allModels.find(m => m.modelId === anchorId);
    if (!anchor) {
        return { isCompatible: true, reason: '' };
    }

    const modelPct = typeof model.remainingPercentage === 'number' ? model.remainingPercentage : null;
    const anchorPct = typeof anchor.remainingPercentage === 'number' ? anchor.remainingPercentage : null;
    if (modelPct !== null && anchorPct !== null && Math.abs(modelPct - anchorPct) > QUOTA_TOLERANCE_PCT) {
        return { isCompatible: false, reason: 'quotaMismatch' };
    }
    if (
        model.resetTimeDisplay
        && anchor.resetTimeDisplay
        && model.resetTimeDisplay !== anchor.resetTimeDisplay
    ) {
        return { isCompatible: false, reason: 'resetMismatch' };
    }
    return { isCompatible: true, reason: '' };
}

/** 新建空分组（ID 唯一，避免同毫秒碰撞互相覆盖） */
export function createGroup(state: GroupEditState): EditableGroup {
    const base = `custom_group_${Date.now()}`;
    const taken = new Set(state.groups.map(g => g.id));
    let id = base;
    let suffix = 1;
    while (taken.has(id)) {
        id = `${base}_${suffix}`;
        suffix++;
    }
    return { id, name: `Group ${state.groups.length + 1}`, modelIds: [] };
}

/** 删除分组 */
export function removeGroup(state: GroupEditState, groupId: string): GroupEditState {
    return {
        ...state,
        groups: state.groups.filter(g => g.id !== groupId),
    };
}

/** 重命名分组 */
export function renameGroup(state: GroupEditState, groupId: string, name: string): GroupEditState {
    const trimmed = name.trim();
    return {
        ...state,
        groups: state.groups.map(g => (g.id === groupId
            ? { ...g, name: trimmed.length > 0 ? trimmed : g.name }
            : g)),
    };
}

/** 把模型加入分组 */
export function addModelToGroup(
    state: GroupEditState,
    groupId: string,
    modelId: string,
): GroupEditState {
    return {
        ...state,
        groups: state.groups.map(g => {
            if (g.id !== groupId || g.modelIds.includes(modelId)) {
                return g;
            }
            return { ...g, modelIds: [...g.modelIds, modelId] };
        }),
    };
}

/** 从分组移除模型 */
export function removeModelFromGroup(
    state: GroupEditState,
    groupId: string,
    modelId: string,
): GroupEditState {
    return {
        ...state,
        groups: state.groups.map(g => (g.id === groupId
            ? { ...g, modelIds: g.modelIds.filter(id => id !== modelId) }
            : g)),
    };
}

/** 尚未分配到任何用户组的模型 */
export function findUnassignedModels(state: GroupEditState): EditableModel[] {
    const assigned = new Set<string>();
    state.groups.forEach(g => g.modelIds.forEach(id => assigned.add(id)));
    return state.allModels.filter(m => !assigned.has(m.modelId));
}

/**
 * 保存为 modelId → groupId 映射（空分组丢弃）。
 * groupId 由成员 modelId 排序拼接而成，保证同样成员得到同样的组标识。
 */
export function buildGroupMappings(state: GroupEditState): {
    groupMappings: Record<string, string>;
    groupNames: Record<string, string>;
} {
    const groupMappings: Record<string, string> = {};
    const groupNames: Record<string, string> = {};

    for (const group of state.groups) {
        if (group.modelIds.length === 0) {
            continue;
        }
        const stableGroupId = [...group.modelIds].sort().join('_');
        for (const modelId of group.modelIds) {
            groupMappings[modelId] = stableGroupId;
            groupNames[modelId] = group.name;
        }
    }

    return { groupMappings, groupNames };
}

/**
 * 由已保存的映射重建编辑状态（打开弹框时使用）。
 * 官方分组（不在 groupMappings 里的模型）不参与编辑——它们由 Google 配额池决定。
 */
export function buildEditStateFromMappings(
    groupMappings: Record<string, string>,
    groupNames: Record<string, string>,
    allModels: readonly EditableModel[],
): GroupEditState {
    const order: string[] = [];
    const buckets = new Map<string, string[]>();

    for (const model of allModels) {
        const groupId = groupMappings[model.modelId];
        if (!groupId) {
            continue;
        }
        if (!buckets.has(groupId)) {
            buckets.set(groupId, []);
            order.push(groupId);
        }
        buckets.get(groupId)!.push(model.modelId);
    }

    const groups: EditableGroup[] = order.map((groupId, index) => {
        const modelIds = buckets.get(groupId)!;
        const anchorName = modelIds
            .map(id => groupNames[id])
            .find(name => typeof name === 'string' && name.trim().length > 0);
        return {
            id: groupId,
            name: anchorName?.trim() || `Group ${index + 1}`,
            modelIds,
        };
    });

    return { groups, allModels: [...allModels] };
}
