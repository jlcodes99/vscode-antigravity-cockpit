/**
 * 用户自定义分组弹框（webview 侧）。
 *
 * 官方分组由 Google 配额池决定，用户只能重命名；本模块让用户可以自主建组，
 * 并把模型放进自建组。所有状态变更走 shared/custom_group_editor 的纯函数。
 */

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
    createGroupState,
} from '../../shared/custom_group_editor';

/**
 * @typedef {Object} CustomGroupsModuleDeps
 * @property {{ postMessage: (message: unknown) => void }} vscode
 * @property {Record<string, string>} i18n
 * @property {(value: string) => string} escapeHtml
 * @property {{ modal: HTMLElement | null, list: HTMLElement | null, unassigned: HTMLElement | null, addBtn: HTMLElement | null, closeBtn: HTMLElement | null, cancelBtn: HTMLElement | null, saveBtn: HTMLElement | null }} dom
 * @property {() => Array<{ modelId: string, label?: string, remainingPercentage?: number, resetTimeDisplay?: string }>} getAllModels
 * @property {() => Record<string, string>} getGroupMappings
 * @property {() => Record<string, string>} getGroupNames
 * @property {(message: string, type?: string) => void} toast
 */

/**
 * @param {CustomGroupsModuleDeps} deps
 */
export function createCustomGroupsModule(deps) {
    const { vscode, i18n, dom } = deps;
    const escapeHtml = deps.escapeHtml;
    let state = createGroupState(deps.getAllModels());

    /**
     * @param {string} key
     * @param {string} fallback
     */
    function t(key, fallback) {
        return i18n[key] || fallback;
    }

    function open() {
        if (!dom.modal) {
            return;
        }
        state = buildEditStateFromMappings(
            deps.getGroupMappings() || {},
            deps.getGroupNames() || {},
            deps.getAllModels(),
        );
        render();
        dom.modal.classList.remove('hidden');
    }

    function close() {
        dom.modal?.classList.add('hidden');
    }

    function render() {
        if (!dom.list) {
            return;
        }
        dom.list.innerHTML = state.groups.length === 0
            ? `<div class="empty-groups-hint">${escapeHtml(t('customGroups.noGroups', 'No custom groups yet. Click "Add Group" to create one.'))}</div>`
            : state.groups.map((group, index) => {
                const modelsHtml = group.modelIds.map(modelId => {
                    const model = state.allModels.find(m => m.modelId === modelId);
                    const name = model ? (model.label || modelId) : modelId;
                    return `
                        <span class="custom-model-tag" data-model-id="${escapeHtml(modelId)}">
                            ${escapeHtml(name)}
                            <button class="custom-group-remove-model" data-group-id="${escapeHtml(group.id)}" data-model-id="${escapeHtml(modelId)}" title="${escapeHtml(t('customGroups.removeModel', 'Remove'))}">×</button>
                        </span>
                    `;
                }).join('');

                return `
                    <div class="custom-group-item" data-group-id="${escapeHtml(group.id)}">
                        <div class="custom-group-header">
                            <div class="custom-group-name">
                                <span>📦</span>
                                <input type="text" value="${escapeHtml(group.name)}" data-group-id="${escapeHtml(group.id)}" placeholder="${escapeHtml(t('customGroups.groupName', 'Group name...'))}">
                            </div>
                            <div class="custom-group-actions">
                                <button class="custom-group-delete" data-group-id="${escapeHtml(group.id)}" title="${escapeHtml(t('customGroups.deleteGroup', 'Delete Group'))}">🗑️</button>
                            </div>
                        </div>
                        <div class="custom-group-models">
                            ${modelsHtml}
                            <button class="custom-group-add-model" data-group-id="${escapeHtml(group.id)}">
                                ➕ ${escapeHtml(t('customGroups.addModel', 'Add Model'))}
                            </button>
                        </div>
                    </div>
                `;
            }).join('');

        dom.list.querySelectorAll('.custom-group-remove-model').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const groupId = btn.getAttribute('data-group-id');
                const modelId = btn.getAttribute('data-model-id');
                if (groupId && modelId) {
                    state = removeModelFromGroup(state, groupId, modelId);
                    render();
                }
            });
        });
        dom.list.querySelectorAll('.custom-group-delete').forEach(btn => {
            btn.addEventListener('click', () => {
                const groupId = btn.getAttribute('data-group-id');
                if (groupId) {
                    state = removeGroup(state, groupId);
                    render();
                }
            });
        });
        dom.list.querySelectorAll('.custom-group-add-model').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const groupId = btn.getAttribute('data-group-id');
                if (groupId) {
                    openModelPicker(btn, groupId);
                }
            });
        });
        dom.list.querySelectorAll('.custom-group-name input').forEach(input => {
            input.addEventListener('change', () => {
                const groupId = input.getAttribute('data-group-id');
                if (groupId) {
                    state = renameGroup(state, groupId, input.value);
                    render();
                }
            });
        });

        renderUnassigned();
    }

    function renderUnassigned() {
        if (!dom.unassigned) {
            return;
        }
        const unassigned = findUnassignedModels(state);
        if (unassigned.length === 0) {
            dom.unassigned.innerHTML = `<div style="color: var(--text-secondary); font-size: 12px;">${escapeHtml(t('customGroups.allAssigned', 'All models are in a custom group'))}</div>`;
            return;
        }
        dom.unassigned.innerHTML = unassigned.map(model => {
            const pct = (model.remainingPercentage ?? 0).toFixed(0);
            return `
                <span class="custom-model-tag readonly" title="${escapeHtml(model.modelId)}">
                    ${escapeHtml(model.label || model.modelId)}
                    <span class="model-quota">${pct}%</span>
                </span>
            `;
        }).join('');
    }

    /**
     * @param {HTMLElement} anchor
     * @param {string} groupId
     */
    function openModelPicker(anchor, groupId) {
        const existingDropdown = document.querySelector('.model-select-dropdown');
        if (existingDropdown) {
            existingDropdown.remove();
        }

        const group = state.groups.find(g => g.id === groupId);
        if (!group) {
            return;
        }
        const candidates = findUnassignedModels(state);
        if (candidates.length === 0) {
            deps.toast(t('customGroups.noModels', 'No available models'), 'info');
            return;
        }

        const dropdown = document.createElement('div');
        dropdown.className = 'model-select-dropdown';

        const rect = anchor.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.top = `${rect.bottom + 4}px`;

        const items = candidates
            .map(model => {
                const compat = isModelCompatibleWithGroup(model, group, state.allModels);
                const pct = (model.remainingPercentage ?? 0).toFixed(1);
                const reason = compat.reason === 'quotaMismatch'
                    ? t('customGroups.quotaMismatch', 'Quota mismatch')
                    : compat.reason === 'resetMismatch'
                        ? t('customGroups.resetMismatch', 'Reset time mismatch')
                        : '';
                return `
                    <label class="model-select-item ${compat.isCompatible ? '' : 'incompatible'}"
                           data-model-id="${escapeHtml(model.modelId)}">
                        <input type="checkbox" class="model-checkbox" value="${escapeHtml(model.modelId)}">
                        <span class="model-name">${escapeHtml(model.label || model.modelId)}</span>
                        <span class="model-quota">${pct}%</span>
                        ${reason ? `<span class="incompatible-reason">${escapeHtml(reason)}</span>` : ''}
                    </label>
                `;
            })
            .join('');

        dropdown.innerHTML = `
            <div class="model-select-list">${items}</div>
            <div class="model-select-footer">
                <button class="btn-confirm-add" disabled>
                    ${escapeHtml(t('customGroups.addModel', 'Add'))} (<span class="selected-count">0</span>)
                </button>
            </div>
        `;
        document.body.appendChild(dropdown);

        const confirmBtn = dropdown.querySelector('.btn-confirm-add');
        const countSpan = dropdown.querySelector('.selected-count');
        const checkboxes = Array.from(dropdown.querySelectorAll('.model-checkbox'));

        const updateSelection = () => {
            const checked = checkboxes.filter(cb => cb.checked);
            if (countSpan) {
                countSpan.textContent = String(checked.length);
            }
            if (confirmBtn) {
                confirmBtn.disabled = checked.length === 0;
            }
        };
        checkboxes.forEach(cb => cb.addEventListener('change', updateSelection));
        updateSelection();

        confirmBtn?.addEventListener('click', () => {
            const selected = checkboxes.filter(cb => cb.checked).map(cb => cb.value);
            selected.forEach(modelId => {
                state = addModelToGroup(state, groupId, modelId);
            });
            dropdown.remove();
            render();
        });
    }

    function save() {
        const { groupMappings, groupNames } = buildGroupMappings(state);
        vscode.postMessage({
            command: 'saveCustomGrouping',
            customGroupMappings: groupMappings,
            customGroupNames: groupNames,
        });
        deps.toast(t('customGroups.saved', 'Custom groups saved'), 'success');
        close();
    }

    function init() {
        dom.addBtn?.addEventListener('click', () => {
            state = { ...state, groups: [...state.groups, createGroup(state)] };
            render();
        });
        dom.closeBtn?.addEventListener('click', close);
        dom.cancelBtn?.addEventListener('click', close);
        dom.saveBtn?.addEventListener('click', save);
    }

    return { init, open, close };
}
