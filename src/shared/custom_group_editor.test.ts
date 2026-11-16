import {
    addModelToGroup,
    buildEditStateFromMappings,
    buildGroupMappings,
    createGroup,
    findUnassignedModels,
    isModelCompatibleWithGroup,
    removeGroup,
    removeModelFromGroup,
    renameGroup,
    type EditableModel,
    type GroupEditState,
} from './custom_group_editor';

const models: EditableModel[] = [
    { modelId: 'gemini-4-pro-high', label: 'Gemini 4 Pro (High)', remainingPercentage: 77.68561, resetTimeDisplay: '2026-11-16 05:15' },
    { modelId: 'gemini-4-pro-low', label: 'Gemini 4 Pro (Low)', remainingPercentage: 77.685610000001, resetTimeDisplay: '2026-11-16 05:15' },
    { modelId: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)', remainingPercentage: 100, resetTimeDisplay: '2026-11-16 08:04' },
];

describe('createGroup', () => {
    it('创建空分组并按组数命名', () => {
        const state: GroupEditState = { groups: [], allModels: models };
        const group = createGroup(state);
        expect(group.modelIds).toEqual([]);
        expect(group.name).toBe('Group 1');
    });

    it('同毫秒内创建两个组不会 ID 碰撞', () => {
        const state: GroupEditState = { groups: [], allModels: models };
        const first = createGroup(state);
        const second = createGroup({ ...state, groups: [first] });
        expect(second.id).not.toBe(first.id);
    });
});

describe('renameGroup / removeGroup', () => {
    it('重命名（不改原对象）', () => {
        const state: GroupEditState = { groups: [{ id: 'g1', name: 'Group 1', modelIds: [] }], allModels: models };
        const next = renameGroup(state, 'g1', '  My Group  ');
        expect(next.groups[0].name).toBe('My Group');
        expect(state.groups[0].name).toBe('Group 1');
    });

    it('空名不生效', () => {
        const state: GroupEditState = { groups: [{ id: 'g1', name: 'Keep', modelIds: [] }], allModels: models };
        expect(renameGroup(state, 'g1', '   ').groups[0].name).toBe('Keep');
    });

    it('删除分组', () => {
        const state: GroupEditState = {
            groups: [{ id: 'g1', name: 'A', modelIds: ['x'] }, { id: 'g2', name: 'B', modelIds: [] }],
            allModels: models,
        };
        expect(removeGroup(state, 'g1').groups.map(g => g.id)).toEqual(['g2']);
    });
});

describe('addModelToGroup / removeModelFromGroup', () => {
    it('加入与移除模型（不改原对象）', () => {
        const state: GroupEditState = { groups: [{ id: 'g1', name: 'G', modelIds: [] }], allModels: models };
        const added = addModelToGroup(state, 'g1', 'gemini-4-pro-high');
        expect(added.groups[0].modelIds).toEqual(['gemini-4-pro-high']);
        expect(state.groups[0].modelIds).toEqual([]);

        const removed = removeModelFromGroup(added, 'g1', 'gemini-4-pro-high');
        expect(removed.groups[0].modelIds).toEqual([]);
    });

    it('重复加入不产生重复项', () => {
        const state: GroupEditState = { groups: [{ id: 'g1', name: 'G', modelIds: ['gemini-4-pro-high'] }], allModels: models };
        expect(addModelToGroup(state, 'g1', 'gemini-4-pro-high').groups[0].modelIds).toEqual(['gemini-4-pro-high']);
    });
});

describe('findUnassignedModels', () => {
    it('返回尚未分配到用户组的模型', () => {
        const state: GroupEditState = {
            groups: [{ id: 'g1', name: 'G', modelIds: ['gemini-4-pro-high'] }],
            allModels: models,
        };
        expect(findUnassignedModels(state).map(m => m.modelId)).toEqual(['gemini-4-pro-low', 'claude-opus-5-5-high']);
    });
});

describe('isModelCompatibleWithGroup', () => {
    it('空组时任意模型都可加入', () => {
        const group = { id: 'g', name: 'G', modelIds: [] };
        expect(isModelCompatibleWithGroup(models[2], group, models).isCompatible).toBe(true);
    });

    it('浮点尾数差异仍判为兼容', () => {
        const group = { id: 'g', name: 'G', modelIds: ['gemini-4-pro-high'] };
        expect(isModelCompatibleWithGroup(models[1], group, models).isCompatible).toBe(true);
    });

    it('配额明显不同判为不兼容', () => {
        const group = { id: 'g', name: 'G', modelIds: ['gemini-4-pro-high'] };
        const result = isModelCompatibleWithGroup(models[2], group, models);
        expect(result.isCompatible).toBe(false);
        expect(result.reason).toBe('quotaMismatch');
    });

    it('重置时间不同判为不兼容', () => {
        const group = { id: 'g', name: 'G', modelIds: ['gemini-4-pro-high'] };
        const result = isModelCompatibleWithGroup(
            { modelId: 'X', remainingPercentage: 77.68561, resetTimeDisplay: '2026-11-17 05:15' },
            group,
            models,
        );
        expect(result.reason).toBe('resetMismatch');
    });
});

describe('buildGroupMappings', () => {
    it('组内成员共享稳定 ID，组名按成员保存', () => {
        const state: GroupEditState = {
            groups: [{ id: 'g1', name: 'My Pro', modelIds: ['gemini-4-pro-low', 'gemini-4-pro-high'] }],
            allModels: models,
        };
        const { groupMappings, groupNames } = buildGroupMappings(state);
        expect(groupMappings).toEqual({
            'gemini-4-pro-high': 'gemini-4-pro-high_gemini-4-pro-low',
            'gemini-4-pro-low': 'gemini-4-pro-high_gemini-4-pro-low',
        });
        expect(groupNames['gemini-4-pro-high']).toBe('My Pro');
    });

    it('空分组不保存', () => {
        const state: GroupEditState = {
            groups: [{ id: 'g1', name: 'Empty', modelIds: [] }, { id: 'g2', name: 'Full', modelIds: ['a'] }],
            allModels: models,
        };
        expect(Object.keys(buildGroupMappings(state).groupMappings)).toEqual(['a']);
    });
});

describe('buildEditStateFromMappings', () => {
    it('由映射重建分组并恢复组名', () => {
        const state = buildEditStateFromMappings(
            { 'gemini-4-pro-high': 'g1', 'gemini-4-pro-low': 'g1' },
            { 'gemini-4-pro-high': 'Pro Group' },
            models,
        );
        expect(state.groups).toHaveLength(1);
        expect(state.groups[0].name).toBe('Pro Group');
        expect(state.groups[0].modelIds).toEqual(['gemini-4-pro-high', 'gemini-4-pro-low']);
    });

    it('无映射时无用户分组', () => {
        expect(buildEditStateFromMappings({}, {}, models).groups).toEqual([]);
    });
});

describe('端到端：建组 → 加模型 → 保存 → 重开', () => {
    it('用户自建分组可保存并完整恢复', () => {
        let state: GroupEditState = { groups: [], allModels: models };

        // 1. 建组
        const group = createGroup(state);
        state = { ...state, groups: [...state.groups, group] };
        state = renameGroup(state, group.id, 'My Group');

        // 2. 加两个模型（配额不同也允许）
        state = addModelToGroup(state, group.id, 'gemini-4-pro-high');
        state = addModelToGroup(state, group.id, 'claude-opus-5-5-high');

        // 3. 保存
        const { groupMappings, groupNames } = buildGroupMappings(state);
        expect(Object.keys(groupMappings).sort()).toEqual(['claude-opus-5-5-high', 'gemini-4-pro-high']);

        // 4. 重开：组名与成员都在
        const reopened = buildEditStateFromMappings(groupMappings, groupNames, models);
        expect(reopened.groups).toHaveLength(1);
        expect(reopened.groups[0].name).toBe('My Group');
        expect(reopened.groups[0].modelIds.sort()).toEqual(['claude-opus-5-5-high', 'gemini-4-pro-high']);
    });
});
