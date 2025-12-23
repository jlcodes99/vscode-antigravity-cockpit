/**
 * Antigravity Cockpit - Dashboard 脚本
 * 处理 Webview 交互逻辑
 */

(function() {
    'use strict';

    // 获取 VS Code API
    const vscode = acquireVsCodeApi();

    // DOM 元素
    const dashboard = document.getElementById('dashboard');
    const statusDiv = document.getElementById('status');
    const refreshBtn = document.getElementById('refresh-btn');
    const resetOrderBtn = document.getElementById('reset-order-btn');
    const toast = document.getElementById('toast');
    const settingsModal = document.getElementById('settings-modal');
    const renameModal = document.getElementById('rename-modal');

    // 国际化文本
    const i18n = window.__i18n || {};

    // 状态
    let isRefreshing = false;
    let dragSrcEl = null;
    let currentConfig = {};
    let lastSnapshot = null; // Store last snapshot for re-renders
    let renameGroupId = null; // 当前正在重命名的分组 ID
    let renameModelIds = [];  // 当前分组包含的模型 ID
    let renameModelId = null; // 当前正在重命名的模型 ID（非分组模式）
    let isRenamingModel = false; // 标记是否正在重命名模型（而非分组）
    let currentViewMode = 'card';
    let renameOriginalName = ''; // 原始名称（用于重置）
    let isProfileHidden = false;  // 控制整个计划详情卡片的显示/隐藏
    let isDataMasked = false;     // 控制数据是否显示为 ***

    // 刷新冷却时间（秒），默认 120 秒
    let refreshCooldown = 120;

    // ============ 初始化 ============

    function init() {
        // 恢复状态
        const state = vscode.getState() || {};
        if (state.lastRefresh && state.refreshCooldown) {
            const now = Date.now();
            const diff = Math.floor((now - state.lastRefresh) / 1000);
            if (diff < state.refreshCooldown) {
                startCooldown(state.refreshCooldown - diff);
            }
        }
        
        // isProfileHidden, currentViewMode, and isDataMasked are now loaded from config in handleMessage

        // 绑定事件
        refreshBtn.addEventListener('click', handleRefresh);
        
        // 初始化富文本 Tooltip
        initRichTooltip();
        if (resetOrderBtn) {
            resetOrderBtn.addEventListener('click', handleResetOrder);
        }
        
        // 计划详情开关按钮
        const toggleProfileBtn = document.getElementById('toggle-profile-btn');
        if (toggleProfileBtn) {
            toggleProfileBtn.addEventListener('click', handleToggleProfile);
        }
        
        // 分组开关按钮
        const toggleGroupingBtn = document.getElementById('toggle-grouping-btn');
        if (toggleGroupingBtn) {
            toggleGroupingBtn.addEventListener('click', handleToggleGrouping);
        }
        
        // 设置按钮
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', openSettingsModal);
        }
        
        // 关闭设置模态框
        const closeSettingsBtn = document.getElementById('close-settings-btn');
        if (closeSettingsBtn) {
            closeSettingsBtn.addEventListener('click', closeSettingsModal);
        }
        
        // 重命名模态框 - 关闭按钮
        const closeRenameBtn = document.getElementById('close-rename-btn');
        if (closeRenameBtn) {
            closeRenameBtn.addEventListener('click', closeRenameModal);
        }
        
        // 重命名模态框 - 确定按钮
        const saveRenameBtn = document.getElementById('save-rename-btn');
        if (saveRenameBtn) {
            saveRenameBtn.addEventListener('click', saveRename);
        }
        
        // 重命名输入框 - 回车键确认
        const renameInput = document.getElementById('rename-input');
        if (renameInput) {
            renameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    saveRename();
                }
            });
        }
        
        // 重置名称按钮
        const resetNameBtn = document.getElementById('reset-name-btn');
        if (resetNameBtn) {
            resetNameBtn.addEventListener('click', resetName);
        }

        // 事件委托：处理置顶开关
        dashboard.addEventListener('change', (e) => {
            if (e.target.classList.contains('pin-toggle')) {
                const modelId = e.target.getAttribute('data-model-id');
                if (modelId) {
                    togglePin(modelId);
                }
            }
        });

        // 监听消息
        window.addEventListener('message', handleMessage);

        // 通知扩展已准备就绪
        vscode.postMessage({ command: 'init' });
    }
    
    // ============ 设置模态框 ============
    
    function openSettingsModal() {
        if (settingsModal) {
            // 从当前配置填充值
            const notificationCheckbox = document.getElementById('notification-enabled');
            const warningInput = document.getElementById('warning-threshold');
            const criticalInput = document.getElementById('critical-threshold');
            if (notificationCheckbox) notificationCheckbox.checked = currentConfig.notificationEnabled !== false;
            if (warningInput) warningInput.value = currentConfig.warningThreshold || 30;
            if (criticalInput) criticalInput.value = currentConfig.criticalThreshold || 10;

            // View Mode Select Logic
            const viewModeSelect = document.getElementById('view-mode-select');
            if (viewModeSelect) {
                viewModeSelect.value = currentViewMode;
                viewModeSelect.onchange = () => {
                   const newViewMode = viewModeSelect.value;
                   vscode.postMessage({ command: 'updateViewMode', viewMode: newViewMode });
                };
            }

            // Display Mode Select Logic (Webview vs QuickPick)
            const displayModeSelect = document.getElementById('display-mode-select');
            if (displayModeSelect) {
                const currentDisplayMode = currentConfig.displayMode || 'webview';
                displayModeSelect.value = currentDisplayMode;
                
                displayModeSelect.onchange = () => {
                    const newMode = displayModeSelect.value;
                    if (newMode === 'quickpick') {
                        // Switching to QuickPick should close Webview
                        vscode.postMessage({ command: 'updateDisplayMode', displayMode: 'quickpick' });
                    }
                };
            }

            // 初始化状态栏格式选择器
            initStatusBarFormatSelector();
            
            // 初始化即时保存事件
            initSettingsAutoSave();

            settingsModal.classList.remove('hidden');
        }
    }
    
    /**
     * 初始化状态栏格式选择器（下拉框）
     */
    function initStatusBarFormatSelector() {
        const formatSelect = document.getElementById('statusbar-format');
        if (!formatSelect) return;
        
        const currentFormat = currentConfig.statusBarFormat || 'standard';
        formatSelect.value = currentFormat;
        
        // 绑定 change 事件
        formatSelect.onchange = null;
        formatSelect.addEventListener('change', () => {
            const format = formatSelect.value;
            
            // 发送消息到扩展，立即更新状态栏
            vscode.postMessage({
                command: 'updateStatusBarFormat',
                statusBarFormat: format
            });
        });
    }
    
    /**
     * 初始化设置自动保存（即时生效）
     */
    function initSettingsAutoSave() {
        const notificationCheckbox = document.getElementById('notification-enabled');
        const warningInput = document.getElementById('warning-threshold');
        const criticalInput = document.getElementById('critical-threshold');
        
        // 通知开关即时保存
        if (notificationCheckbox) {
            notificationCheckbox.onchange = null;
            notificationCheckbox.addEventListener('change', () => {
                vscode.postMessage({
                    command: 'updateNotificationEnabled',
                    notificationEnabled: notificationCheckbox.checked
                });
            });
        }
        
        // 阈值输入框失焦时自动钳位并保存
        if (warningInput) {
            warningInput.onblur = null;
            warningInput.addEventListener('blur', () => {
                clampAndSaveThresholds();
            });
        }
        
        if (criticalInput) {
            criticalInput.onblur = null;
            criticalInput.addEventListener('blur', () => {
                clampAndSaveThresholds();
            });
        }
    }
    
    /**
     * 钳位阈值并保存
     */
    function clampAndSaveThresholds() {
        const warningInput = document.getElementById('warning-threshold');
        const criticalInput = document.getElementById('critical-threshold');
        
        let warningValue = parseInt(warningInput?.value, 10) || 30;
        let criticalValue = parseInt(criticalInput?.value, 10) || 10;

        // 自动钳制到有效范围
        if (warningValue < 5) warningValue = 5;
        if (warningValue > 80) warningValue = 80;
        if (criticalValue < 1) criticalValue = 1;
        if (criticalValue > 50) criticalValue = 50;

        // 确保 critical < warning
        if (criticalValue >= warningValue) {
            criticalValue = warningValue - 1;
            if (criticalValue < 1) criticalValue = 1;
        }

        // 更新输入框显示钳制后的值
        if (warningInput) warningInput.value = warningValue;
        if (criticalInput) criticalInput.value = criticalValue;

        saveThresholds();
    }
    
    /**
     * 保存阈值设置
     */
    function saveThresholds() {
        const notificationCheckbox = document.getElementById('notification-enabled');
        const warningInput = document.getElementById('warning-threshold');
        const criticalInput = document.getElementById('critical-threshold');

        const notificationEnabled = notificationCheckbox?.checked ?? true;
        const warningValue = parseInt(warningInput?.value, 10) || 30;
        const criticalValue = parseInt(criticalInput?.value, 10) || 10;

        // 发送到扩展保存
        vscode.postMessage({
            command: 'updateThresholds',
            notificationEnabled: notificationEnabled,
            warningThreshold: warningValue,
            criticalThreshold: criticalValue
        });
    }
    
    function closeSettingsModal() {
        if (settingsModal) {
            settingsModal.classList.add('hidden');
        }
    }
    
    // ============ 重命名模态框 ============
    
    function openRenameModal(groupId, currentName, modelIds) {
        if (renameModal) {
            renameGroupId = groupId;
            renameModelIds = modelIds || [];
            isRenamingModel = false; // 分组重命名模式
            renameModelId = null;
            
            const renameInput = document.getElementById('rename-input');
            if (renameInput) {
                renameInput.value = currentName || '';
                renameInput.focus();
                renameInput.select();
            }
            
            renameModal.classList.remove('hidden');
        }
    }
    
    /**
     * 打开模型重命名模态框（非分组模式）
     * @param {string} modelId 模型 ID
     * @param {string} currentName 当前名称
     */
    function openModelRenameModal(modelId, currentName, originalName) {
        if (renameModal) {
            isRenamingModel = true; // 模型重命名模式
            renameModelId = modelId;
            renameGroupId = null;
            renameModelIds = [];
            renameOriginalName = originalName || currentName || ''; // 保存原始名称
            
            const renameInput = document.getElementById('rename-input');
            if (renameInput) {
                renameInput.value = currentName || '';
                renameInput.focus();
                renameInput.select();
            }
            
            renameModal.classList.remove('hidden');
        }
    }
    
    function closeRenameModal() {
        if (renameModal) {
            renameModal.classList.add('hidden');
            renameGroupId = null;
            renameModelIds = [];
            renameModelId = null;
            isRenamingModel = false;
            renameOriginalName = '';
        }
    }
    
    function saveRename() {
        const renameInput = document.getElementById('rename-input');
        const newName = renameInput?.value?.trim();
        
        if (!newName) {
            showToast(i18n['model.nameEmpty'] || i18n['grouping.nameEmpty'] || 'Name cannot be empty', 'error');
            return;
        }
        
        if (isRenamingModel && renameModelId) {
            // 模型重命名模式
            vscode.postMessage({
                command: 'renameModel',
                modelId: renameModelId,
                groupName: newName  // 复用 groupName 字段
            });
            
            showToast((i18n['model.renamed'] || 'Model renamed to {name}').replace('{name}', newName), 'success');
        } else if (renameGroupId && renameModelIds.length > 0) {
            // 分组重命名模式
            vscode.postMessage({
                command: 'renameGroup',
                groupId: renameGroupId,
                groupName: newName,
                modelIds: renameModelIds
            });
            
            showToast((i18n['grouping.renamed'] || 'Renamed to {name}').replace('{name}', newName), 'success');
        }
        
        closeRenameModal();
    }
    /**
     * 重置名称为默认值（填入输入框，不直接提交）
     */
    function resetName() {
        const renameInput = document.getElementById('rename-input');
        if (!renameInput) return;
        
        if (isRenamingModel && renameModelId && renameOriginalName) {
            // 模型重置模式：将原始名称填入输入框
            renameInput.value = renameOriginalName;
            renameInput.focus();
        }
        // 分组重置暂不支持
    }
    
    function handleToggleProfile() {
        // Send command to extension to toggle and persist in VS Code config
        vscode.postMessage({ command: 'toggleProfile' });
    }
    
    function updateToggleProfileButton() {
        const btn = document.getElementById('toggle-profile-btn');
        if (btn) {
            if (isProfileHidden) {
                btn.textContent = (i18n['profile.planDetails'] || 'Plan') + ' ▼';
                btn.classList.add('toggle-off');
            } else {
                btn.textContent = (i18n['profile.planDetails'] || 'Plan') + ' ▲';
                btn.classList.remove('toggle-off');
            }
        }
    }
    
    function handleToggleGrouping() {
        // 发送切换分组的消息给扩展
        vscode.postMessage({ command: 'toggleGrouping' });
    }
    
    function updateToggleGroupingButton(enabled) {
        const btn = document.getElementById('toggle-grouping-btn');
        if (btn) {
            if (enabled) {
                btn.textContent = (i18n['grouping.title'] || 'Groups') + ' ▲';
                btn.classList.remove('toggle-off');
            } else {
                btn.textContent = (i18n['grouping.title'] || 'Groups') + ' ▼';
                btn.classList.add('toggle-off');
            }
        }
    }

    // ============ 事件处理 ============

    function handleRefresh() {
        if (refreshBtn.disabled) return;

        isRefreshing = true;
        updateRefreshButton();
        showToast(i18n['notify.refreshing'] || 'Refreshing quota data...', 'info');

        vscode.postMessage({ command: 'refresh' });

        const now = Date.now();
        vscode.setState({ ...vscode.getState(), lastRefresh: now, refreshCooldown: refreshCooldown });
        startCooldown(refreshCooldown);
    }



    function handleResetOrder() {
        vscode.postMessage({ command: 'resetOrder' });
        showToast(i18n['dashboard.resetOrder'] || 'Reset Order', 'success');
    }

    function handleAutoGroup() {
        vscode.postMessage({ command: 'autoGroup' });
        showToast(i18n['grouping.autoGroup'] || 'Auto grouping...', 'info');
    }

    function handleMessage(event) {
        const message = event.data;
        
        if (message.type === 'telemetry_update') {
            isRefreshing = false;
            updateRefreshButton();
            
            // 保存配置
            if (message.config) {
                currentConfig = message.config;
                
                // 从配置更新刷新冷却时间
                if (message.config.refreshInterval) {
                    refreshCooldown = message.config.refreshInterval;
                }
                
                // 从配置读取 profileHidden 和 viewMode（持久化存储）
                if (message.config.profileHidden !== undefined) {
                    isProfileHidden = message.config.profileHidden;
                    updateToggleProfileButton();
                }
                if (message.config.viewMode) {
                    currentViewMode = message.config.viewMode;
                }
                // 从配置读取 dataMasked 状态（持久化存储）
                if (message.config.dataMasked !== undefined) {
                    isDataMasked = message.config.dataMasked;
                }
            }
            
            render(message.data, message.config);
            lastSnapshot = message.data; // Update global snapshot
        }
    }

    // ============ 刷新按钮逻辑 ============

    function updateRefreshButton() {
        if (isRefreshing) {
            refreshBtn.innerHTML = `<span class="spinner"></span>${i18n['dashboard.refreshing'] || 'Refreshing...'}`;
        }
    }

    function startCooldown(seconds) {
        refreshBtn.disabled = true;
        refreshBtn.innerHTML = seconds + 's';

        let remaining = seconds;
        const timer = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(timer);
                refreshBtn.disabled = false;
                refreshBtn.innerHTML = i18n['dashboard.refresh'] || 'REFRESH';
            } else {
                refreshBtn.innerHTML = remaining + 's';
            }
        }, 1000);
    }

    // ============ Toast 通知 ============

    function showToast(message, type = 'info') {
        if (!toast) return;

        toast.textContent = message;
        toast.className = `toast ${type}`;
        
        // 3秒后隐藏
        setTimeout(() => {
            toast.classList.add('hidden');
        }, 3000);
    }

    // ============ 工具函数 ============

    function getHealthColor(percentage) {
        // 使用配置的阈值
        const warningThreshold = currentConfig.warningThreshold || 30;
        const criticalThreshold = currentConfig.criticalThreshold || 10;
        
        if (percentage > warningThreshold) return 'var(--success)';  // 绿色
        if (percentage > criticalThreshold) return 'var(--warning)';  // 黄色
        return 'var(--danger)';                                       // 红色
    }

    function getStatusText(percentage) {
        // 使用配置的阈值
        const warningThreshold = currentConfig.warningThreshold || 30;
        const criticalThreshold = currentConfig.criticalThreshold || 10;
        
        if (percentage > warningThreshold) return i18n['dashboard.active'] || 'Healthy';   // 健康
        if (percentage > criticalThreshold) return i18n['dashboard.warning'] || 'Warning';  // 警告
        return i18n['dashboard.danger'] || 'Danger';                                        // 危险
    }

    /**
     * 解析模型能力，返回图标数组
     * @param {Object} model 模型对象
     * @returns {string[]} 能力图标 HTML 数组
     */


    function togglePin(modelId) {
        vscode.postMessage({ command: 'togglePin', modelId: modelId });
    }

    function retryConnection() {
        vscode.postMessage({ command: 'retry' });
    }

    function openLogs() {
        vscode.postMessage({ command: 'openLogs' });
    }

    function renderListView(snapshot, config) {
        const container = document.createElement('div');
        container.className = 'list-view-container';

        const table = document.createElement('table');
        table.className = 'list-view-table';
        
        // Define Headers (Responsive classes added in CSS)
        // Define Headers (Responsive classes added in CSS)
        const isGrouping = config?.groupingEnabled;
        const nameHeader = isGrouping ? (i18n['grouping.nameLabel'] || 'Group Name') : (i18n['dashboard.modelName'] || 'Model Name');
        const modelsHeader = i18n['grouping.models'] || 'Included Models';

        let theadContent = '';
        if (isGrouping) {
            theadContent = `
                <tr>
                    <th class="col-name">${nameHeader}</th>
                    <th class="col-models">${modelsHeader}</th>
                    <th class="col-status-bar">${i18n['dashboard.remainingQuota'] || 'Remaining Quota'}</th>
                    <th class="col-reset-in">${i18n['dashboard.resetIn'] || 'Reset In'}</th>
                    <th class="col-reset-time">${i18n['dashboard.resetTime'] || 'Reset Time'}</th>
                    <th class="col-actions">${i18n['quickpick.actionsSection'] || 'Actions'}</th>
                </tr>
            `;
        } else {
             // Non-grouping mode: No "Included Models" column
             theadContent = `
                <tr>
                    <th class="col-name">${nameHeader}</th>
                    <th class="col-status-bar">${i18n['dashboard.remainingQuota'] || 'Remaining Quota'}</th>
                    <th class="col-reset-in">${i18n['dashboard.resetIn'] || 'Reset In'}</th>
                    <th class="col-reset-time">${i18n['dashboard.resetTime'] || 'Reset Time'}</th>
                    <th class="col-actions">${i18n['quickpick.actionsSection'] || 'Actions'}</th>
                </tr>
            `;
        }

        table.innerHTML = `
            <thead>
                ${theadContent}
            </thead>
            <tbody></tbody>
        `;
        const tbody = table.querySelector('tbody');

        // Helper to render a common row (model or group)
        const renderRowContent = (item, isGroup = false, isChild = false) => {
            const pct = item.remainingPercentage || 0;
            const color = getHealthColor(pct);
            
            // Determine ID and Name
            const id = isGroup ? item.groupId : item.modelId;
            const name = isGroup 
                ? (config?.groupingCustomNames && config.groupingCustomNames[id]) || item.groupName 
                : (config?.modelCustomNames && config.modelCustomNames[id]) || item.label;

            // Pin Status
            let isPinned = false;
            if (isGroup) {
                isPinned = config?.pinnedGroups?.includes(id);
            } else {
                isPinned = config?.pinnedModels?.includes(id);
            }
            
            const tr = document.createElement('tr');
            tr.draggable = true;
            if (isGroup) {
                tr.className = 'list-group-row';
                tr.setAttribute('data-group-id', id);
            } else {
                tr.setAttribute('data-id', id);
            }
            if (isChild) tr.className = 'list-child-row';

            // Bind Drag & Drop Events
            tr.addEventListener('dragstart', handleDragStart, false);
            tr.addEventListener('dragenter', handleDragEnter, false);
            tr.addEventListener('dragover', handleDragOver, false);
            tr.addEventListener('dragleave', handleDragLeave, false);
            tr.addEventListener('drop', handleDrop, false);
            tr.addEventListener('dragend', handleDragEnd, false);

            // Icon & Caps
            let iconHtml = '';
            let capsHtml = '';
            let tagHtml = '';
            let recIcon = '';

                if (isGrouping) {
                    iconHtml = '<span class="icon" style="margin-right:8px">📦</span>';
                } else {
                    // Model specific logic
                    const caps = getModelCapabilityList(item);
                    if (caps.length > 0) {
                         const tooltipHtml = encodeURIComponent(generateCapabilityTooltip(caps));
                         capsHtml = `<div class="list-caps-icons" data-tooltip-html="${tooltipHtml}">✨</div>`;
                    }
                    tagHtml = item.tagTitle ? `<span class="list-tag-new">${item.tagTitle}</span>` : '';
                    // No star icon for regular models in list view as requested
                    recIcon = ''; 
                }

            // Columns Content
            // 1. Name
            let nameColContent = '';
            // 2. Included Models
            let modelsColContent = '';
            
            if (isGroup) {
                // Group: Show Group Name
                nameColContent = `
                    <div class="list-model-cell">
                        <div class="list-model-icon">${iconHtml}</div>
                        <span class="list-model-name" title="${id}">${name}</span>
                    </div>
                `;

                // Models column
                const childModelsHtml = item.models.map(m => {
                    const mName = (config?.modelCustomNames && config.modelCustomNames[m.modelId]) || m.label;
                    
                    // Recommended logic (class based)
                    const recClass = m.isRecommended ? ' recommended' : '';
                    
                    // Tag
                    const mTagHtml = m.tagTitle ? `<span class="list-tag-mini">${m.tagTitle}</span>` : '';
                    
                    // Capabilities
                    const mCaps = getModelCapabilityList(m);
                    let mCapsHtml = '';
                    let mTooltipAttr = '';
                    if (mCaps.length > 0) {
                        const tooltipHtml = encodeURIComponent(generateCapabilityTooltip(mCaps));
                        mCapsHtml = `<span class="list-caps-dot">✨</span>`;
                        mTooltipAttr = `data-tooltip-html="${tooltipHtml}"`;
                    }
                    
                    return `
                        <div class="list-model-pill${recClass}" ${mTooltipAttr} title="${mName}">
                            <span>${mName}</span>
                            ${mTagHtml}
                            ${mCapsHtml}
                        </div>
                    `;
                }).join('');

                modelsColContent = `
                    <div class="list-inline-models" style="margin-top:0;">
                        ${childModelsHtml}
                    </div>
                `;
            } else {
                // Flat Model
                const caps = getModelCapabilityList(item);
                const hasCapabilities = caps.length > 0;
                const tooltipAttr = hasCapabilities ? `data-tooltip-html="${encodeURIComponent(generateCapabilityTooltip(caps))}"` : '';
                
                nameColContent = `
                    <div class="list-model-cell" ${tooltipAttr}>
                        <span class="list-model-name" title="${id}">${name}</span>
                        ${tagHtml}
                        ${capsHtml}
                    </div>
                `;
                // Models column stays empty for standalone
                modelsColContent = '';
            }

            const nameCol = nameColContent;
            const modelsCol = modelsColContent;

            // 2. Status Circle (Empty for children, full for Group/Flat Model)
            let statusCol = '';
            if (!isChild) {
                statusCol = `
                    <div class="list-progress-circle" style="background: conic-gradient(${color} ${pct}%, var(--border-color) ${pct}%);">
                        <span class="list-progress-text" style="color: ${color}">${Math.floor(pct)}%</span>
                    </div>
                `;
            } else {
                statusCol = `<span style="opacity:0.3; font-size:12px;">—</span>`;
            }

            // 3. Reset In
            let resetInCol = '';
            if (!isChild) {
                resetInCol = `<span class="list-text-secondary">${item.timeUntilResetFormatted || '-'}</span>`;
            }

            // 4. Reset Time
            let resetTimeCol = '';
            if (!isChild) {
                resetTimeCol = `<span class="list-text-secondary">${item.resetTimeDisplay || '-'}</span>`;
            }

            // 5. Actions
            let actionsCol = '';
            const pinHintText = i18n['dashboard.pinHint'] || 'Pin to Status Bar';
            const renameHintText = i18n['model.rename'] || 'Rename';
            if (!isChild) { // Child models in a group usually don't need actions if the group controls them, but rename is useful
                actionsCol = `
                    <div class="list-actions-cell">
                        <button class="rename-btn icon-btn" data-tooltip-html="${encodeURIComponent('<div class=\"rich-tooltip-item\"><span class=\"text\">' + renameHintText + '</span></div>')}">✏️</button>
                        <label class="switch" style="transform: scale(0.8);" data-tooltip-html="${encodeURIComponent('<div class=\"rich-tooltip-item\"><span class=\"text\">' + pinHintText + '</span></div>')}">
                            <input type="checkbox" class="pin-toggle" ${isPinned ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                    </div>
                `;
            } else {
                 // For child models, maybe just rename logic, no pinning (pinned via group)
                 // But wait, can you pin a specific model from a group? Usually grouping implies moving to group logic.
                 // Let's keep rename only for children to match requirement "parent... operation and display logic same as card".
                 // In card mode, children are just text. But rename is useful.
                 actionsCol = `
                    <div class="list-actions-cell">
                         <!-- Optionally allow renaming child models -->
                         <!-- <button class="rename-ptr icon-btn">✏️</button> -->
                    </div>
                 `;
            }

            if (config?.groupingEnabled) {
                tr.innerHTML = `
                    <td>${nameCol}</td>
                    <td>${modelsCol}</td>
                    <td class="col-status-bar">${statusCol}</td>
                    <td class="col-reset-in">${resetInCol}</td>
                    <td class="col-reset-time">${resetTimeCol}</td>
                    <td>${actionsCol}</td>
                `;
            } else {
                 tr.innerHTML = `
                    <td>${nameCol}</td>
                    <td class="col-status-bar">${statusCol}</td>
                    <td class="col-reset-in">${resetInCol}</td>
                    <td class="col-reset-time">${resetTimeCol}</td>
                    <td>${actionsCol}</td>
                `;
            }

            // Bind Events
            if (!isChild) {
                // Rename
                const renameBtn = tr.querySelector('.rename-btn');
                if (renameBtn) {
                    renameBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (isGroup) {
                            // Extract model IDs for group rename logic if needed, but passing groupId is enough for openRenameModal usually
                            // Actually dashboard.js `openRenameModal` takes (groupId, currentName, modelIds)
                            const ids = item.models ? item.models.map(m => m.modelId) : [];
                            openRenameModal(item.groupId, name, ids);
                        } else {
                            openModelRenameModal(item.modelId, name, item.label);
                        }
                    });
                }

                // Pin
                const pinToggle = tr.querySelector('.pin-toggle');
                if (pinToggle) {
                    pinToggle.addEventListener('change', (e) => {
                        e.stopPropagation();
                        if (isGroup) {
                             // Assuming togglePin supports group logic or we have a command for it
                             // Check extension.ts or handle message. 
                             // Wait, dashboard.js togglePin only takes modelId.
                             // We need to send a specific group command or updated togglePin.
                             // Based on config 'pinnedGroups', there must be a way. 
                             // Let's assume 'toggleGroupPin' exists or create it.
                             vscode.postMessage({ command: 'toggleGroupPin', groupId: item.groupId });
                        } else {
                            togglePin(item.modelId);
                        }
                    });
                }
            }

            return tr;
        };


        // Logic for Grouping vs Flat
        if (config?.groupingEnabled) {
            // Render Auto-Group Toolbar
            const bar = document.createElement('div');
            bar.className = 'auto-group-toolbar';
            bar.style.marginBottom = '10px';
            bar.innerHTML = `
                <span class="grouping-hint">
                    ${i18n['grouping.description'] || 'This mode aggregates models sharing the same quota.'}
                </span>
                <button id="list-auto-group-btn" class="auto-group-link" title="${i18n['grouping.autoGroupHint']}">
                    <span class="icon">🔄</span>
                    ${i18n['grouping.autoGroup'] || 'Auto Group'}
                </button>
            `;
            container.appendChild(bar);
            
            const btn = bar.querySelector('#list-auto-group-btn');
            if (btn) btn.addEventListener('click', handleAutoGroup);
        }

        if (config?.groupingEnabled && snapshot.groups && snapshot.groups.length > 0) {
            // === Grouped View ===
            
            // Sort Groups
            let groups = [...snapshot.groups];
            if (config?.groupOrder?.length > 0) {
                const orderMap = new Map();
                config.groupOrder.forEach((id, index) => orderMap.set(id, index));
                groups.sort((a, b) => {
                    const idxA = orderMap.has(a.groupId) ? orderMap.get(a.groupId) : 99999;
                    const idxB = orderMap.has(b.groupId) ? orderMap.get(b.groupId) : 99999;
                    if (idxA !== idxB) return idxA - idxB;
                    // Lower percentage first
                    return a.remainingPercentage - b.remainingPercentage;
                });
            }

            groups.forEach(group => {
                // 1. Render Group Parent Row (Now includes children inline)
                tbody.appendChild(renderRowContent(group, true, false));
                // No longer render individual child rows based on user request ("ugly")
            });

        } else {
            // === Flat View ===
            
            let models = [...snapshot.models];
            if (config?.modelOrder?.length > 0) {
                const orderMap = new Map();
                config.modelOrder.forEach((id, index) => orderMap.set(id, index));
                models.sort((a, b) => {
                    const idxA = orderMap.has(a.modelId) ? orderMap.get(a.modelId) : 99999;
                    const idxB = orderMap.has(b.modelId) ? orderMap.get(b.modelId) : 99999;
                    return idxA - idxB;
                });
            }

            models.forEach(model => {
                tbody.appendChild(renderRowContent(model, false, false));
            });
        }

        container.appendChild(table);
        dashboard.appendChild(container);
    }


    window.retryConnection = retryConnection;
    window.openLogs = openLogs;

    // ============ 拖拽排序 ============

    function handleDragStart(e) {
        this.style.opacity = '0.4';
        dragSrcEl = this;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', this.getAttribute('data-id'));
        this.classList.add('dragging');
    }

    function handleDragOver(e) {
        if (e.preventDefault) {
            e.preventDefault();
        }
        e.dataTransfer.dropEffect = 'move';
        return false;
    }

    function handleDragEnter() {
        this.classList.add('over');
    }

    function handleDragLeave() {
        this.classList.remove('over');
    }

    function handleDrop(e) {
        if (e.stopPropagation) {
            e.stopPropagation();
        }

        if (dragSrcEl !== this) {
            // Get siblings of the same group (cards in dashboard or rows in tbody)
            const selector = dragSrcEl.classList.contains('card') ? '.card' : 'tr';
            const dashboardOrTbody = dragSrcEl.parentElement;
            const items = Array.from(dashboardOrTbody.querySelectorAll(selector));
            
            const srcIndex = items.indexOf(dragSrcEl);
            const targetIndex = items.indexOf(this);

            if (srcIndex < targetIndex) {
                this.after(dragSrcEl);
            } else {
                this.before(dragSrcEl);
            }

            // Get updated list of all items in this container
            const updatedItems = Array.from(dashboardOrTbody.querySelectorAll(selector));
            
            // 检查是否是分组
            const isGroup = dragSrcEl.classList.contains('group-card') || dragSrcEl.classList.contains('list-group-row');
            
            if (isGroup) {
                const groupOrder = updatedItems
                    .map(item => item.getAttribute('data-group-id'))
                    .filter(id => id !== null);
                
                vscode.postMessage({ command: 'updateGroupOrder', order: groupOrder });
            } else {
                const modelOrder = updatedItems
                    .map(item => item.getAttribute('data-id'))
                    .filter(id => id !== null);
                
                vscode.postMessage({ command: 'updateOrder', order: modelOrder });
            }
        }

        return false;
    }

    function handleDragEnd() {
        this.style.opacity = '1';
        this.classList.remove('dragging');

        document.querySelectorAll('.card, tr').forEach(item => {
            item.classList.remove('over');
        });
    }

    // ============ 渲染 ============

    function render(snapshot, config) {
        statusDiv.style.display = 'none';
        dashboard.innerHTML = '';

        // 检查离线状态
        if (!snapshot.isConnected) {
            renderOfflineCard(snapshot.errorMessage);
            return;
        }

        // Render User Profile (if available) - New Section
        // Check isProfileHidden state before rendering
        if (snapshot.userInfo && !isProfileHidden) {
            renderUserProfile(snapshot.userInfo);
        }

        // ============ LIST VIEW RENDER BRANCH ============
        if (currentViewMode === 'list') {
             renderListView(snapshot, config);
             return;
        }
        // =================================================
        
        // 更新分组按钮状态
        updateToggleGroupingButton(config?.groupingEnabled);
        
        // 如果启用了分组显示，渲染分组卡片
        if (config?.groupingEnabled && snapshot.groups && snapshot.groups.length > 0) {
            // 渲染自动分组按钮区域
            renderAutoGroupBar();
            
            // 分组排序：支持自定义顺序
            let groups = [...snapshot.groups];
            if (config?.groupOrder?.length > 0) {
                const orderMap = new Map();
                config.groupOrder.forEach((id, index) => orderMap.set(id, index));
                
                groups.sort((a, b) => {
                    const idxA = orderMap.has(a.groupId) ? orderMap.get(a.groupId) : 99999;
                    const idxB = orderMap.has(b.groupId) ? orderMap.get(b.groupId) : 99999;
                    if (idxA !== idxB) return idxA - idxB;
                    // 如果没有自定义顺序，按配额百分比升序（低的在前）
                    return a.remainingPercentage - b.remainingPercentage;
                });
            }
            
            groups.forEach(group => {
                renderGroupCard(group, config?.pinnedGroups || []);
            });
            return;
        }

        // 模型排序
        let models = [...snapshot.models];
        if (config?.modelOrder?.length > 0) {
            const orderMap = new Map();
            config.modelOrder.forEach((id, index) => orderMap.set(id, index));

            models.sort((a, b) => {
                const idxA = orderMap.has(a.modelId) ? orderMap.get(a.modelId) : 99999;
                const idxB = orderMap.has(b.modelId) ? orderMap.get(b.modelId) : 99999;
                return idxA - idxB;
            });
        }

        // 渲染模型卡片
        models.forEach(model => {
            renderModelCard(model, config?.pinnedModels || [], config?.modelCustomNames || {});
        });
    }

    function renderOfflineCard(errorMessage) {
        const card = document.createElement('div');
        card.className = 'offline-card';
        card.innerHTML = `
            <div class="icon">🚀</div>
            <h2>${i18n['dashboard.offline'] || 'Systems Offline'}</h2>
            <p>${errorMessage || i18n['dashboard.offlineDesc'] || 'Could not detect Antigravity process. Please ensure Antigravity is running.'}</p>
            <p class="offline-hint">${i18n['dashboard.offlineHint'] || 'Use the status bar button to retry connection.'}</p>
        `;
        dashboard.appendChild(card);
    }

    function renderAutoGroupBar() {
        const bar = document.createElement('div');
        bar.className = 'auto-group-toolbar';
        bar.innerHTML = `
            <span class="grouping-hint">
                ${i18n['grouping.description'] || 'This mode aggregates models sharing the same quota. Supports renaming, sorting, and status bar sync. Click "Auto Group" to intelligently categorize, or toggle "Quota Groups" above to switch back.'}
            </span>
            <button id="auto-group-btn" class="auto-group-link" title="${i18n['grouping.autoGroupHint'] || 'Recalculate groups based on current quota'}">
                <span class="icon">🔄</span>
                ${i18n['grouping.autoGroup'] || 'Auto Group'}
            </button>
        `;
        dashboard.appendChild(bar);
        
        // 绑定点击事件
        const btn = bar.querySelector('#auto-group-btn');
        if (btn) {
            btn.addEventListener('click', handleAutoGroup);
        }
    }

    // State for profile toggle
    let isProfileExpanded = false;

    function renderUserProfile(userInfo) {
        // 如果用户选择隐藏计划详情，直接返回不渲染
        if (isProfileHidden) {
            return;
        }

        const card = document.createElement('div');
        card.className = 'card full-width profile-card';

        // Helper for features (with masking support)
        const getFeatureStatus = (enabled) => {
            if (isDataMasked) return `<span class="tag masked">***</span>`;
            return enabled 
                ? `<span class="tag success">${i18n['feature.enabled'] || 'Enabled'}</span>`
                : `<span class="tag disabled">${i18n['feature.disabled'] || 'Disabled'}</span>`;
        };
        
        // Helper for masking values
        const maskValue = (value) => isDataMasked ? '***' : value;

        // Build Upgrade Info HTML if available
        let upgradeHtml = '';
        if (userInfo.upgradeText && userInfo.upgradeUri && !isDataMasked) {
            upgradeHtml = `
            <div class="upgrade-info">
                <div class="upgrade-text">${userInfo.upgradeText}</div>
                <a href="${userInfo.upgradeUri}" class="upgrade-link" target="_blank">Upgrade Now</a>
            </div>`;
        }

        // Toggle visibility style based on state
        const detailsClass = isProfileExpanded ? 'profile-details' : 'profile-details hidden';
        const toggleText = isProfileExpanded ? (i18n['profile.less'] || 'Show Less') : (i18n['profile.more'] || 'Show More Details');
        const iconTransform = isProfileExpanded ? 'rotate(180deg)' : 'rotate(0deg)';
        
        // Mask button text
        const maskBtnText = isDataMasked ? (i18n['profile.showData'] || 'Show') : (i18n['profile.hideData'] || 'Hide');


        card.innerHTML = `
            <div class="card-title">
                <span class="label">${i18n['profile.details'] || 'Plan Details'}</span>
                <div class="profile-controls">
                    <button class="text-btn" id="profile-mask-btn">${maskBtnText}</button>
                    <div class="tier-badge">${userInfo.tier}</div>
                </div>
            </div>
            
            <div class="profile-grid">
                ${createDetailItem(i18n['profile.email'] || 'Email', maskValue(userInfo.email))}
                ${createDetailItem(i18n['profile.description'] || 'Description', maskValue(userInfo.tierDescription))}
                ${createDetailItem(i18n['feature.webSearch'] || 'Web Search', getFeatureStatus(userInfo.cascadeWebSearchEnabled))}
                ${createDetailItem(i18n['feature.browser'] || 'Browser Access', getFeatureStatus(userInfo.browserEnabled))}
                ${createDetailItem(i18n['feature.knowledgeBase'] || 'Knowledge Base', getFeatureStatus(userInfo.knowledgeBaseEnabled))}
                ${createDetailItem(i18n['feature.mcp'] || 'MCP Servers', getFeatureStatus(userInfo.allowMcpServers))}
                ${createDetailItem(i18n['feature.gitCommit'] || 'Git Commit', getFeatureStatus(userInfo.canGenerateCommitMessages))}
                ${createDetailItem(i18n['feature.context'] || 'Context Window', maskValue(userInfo.maxNumChatInputTokens))}
            </div>

            <div class="${detailsClass}" id="profile-more">
                <div class="profile-grid">
                    ${createDetailItem(i18n['feature.fastMode'] || 'Fast Mode', getFeatureStatus(userInfo.hasAutocompleteFastMode))}
                    ${createDetailItem(i18n['feature.moreCredits'] || 'Can Buy Credits', getFeatureStatus(userInfo.canBuyMoreCredits))}
                    
                    ${createDetailItem(i18n['profile.teamsTier'] || 'Teams Tier', maskValue(userInfo.teamsTier))}
                    ${createDetailItem(i18n['profile.userId'] || 'Tier ID', maskValue(userInfo.userTierId || 'N/A'))}
                    ${createDetailItem(i18n['profile.tabToJump'] || 'Tab To Jump', getFeatureStatus(userInfo.hasTabToJump))}
                    ${createDetailItem(i18n['profile.stickyModels'] || 'Sticky Models', getFeatureStatus(userInfo.allowStickyPremiumModels))}
                    ${createDetailItem(i18n['profile.commandModels'] || 'Command Models', getFeatureStatus(userInfo.allowPremiumCommandModels))}
                    ${createDetailItem(i18n['profile.maxPremiumMsgs'] || 'Max Premium Msgs', maskValue(userInfo.maxNumPremiumChatMessages))}
                    ${createDetailItem(i18n['profile.chatInstructionsCharLimit'] || 'Chat Instructions Char Limit', maskValue(userInfo.maxCustomChatInstructionCharacters))}
                    ${createDetailItem(i18n['profile.pinnedContextItems'] || 'Pinned Context Items', maskValue(userInfo.maxNumPinnedContextItems))}
                    ${createDetailItem(i18n['profile.localIndexSize'] || 'Local Index Size', maskValue(userInfo.maxLocalIndexSize))}
                    ${createDetailItem(i18n['profile.acceptedTos'] || 'Accepted TOS', getFeatureStatus(userInfo.acceptedLatestTermsOfService))}
                    ${createDetailItem(i18n['profile.customizeIcon'] || 'Customize Icon', getFeatureStatus(userInfo.canCustomizeAppIcon))}
                    ${createDetailItem(i18n['profile.cascadeAutoRun'] || 'Cascade Auto Run', getFeatureStatus(userInfo.cascadeCanAutoRunCommands))}
                    ${createDetailItem(i18n['profile.cascadeBackground'] || 'Cascade Background', getFeatureStatus(userInfo.canAllowCascadeInBackground))}
                    ${createDetailItem(i18n['profile.autoRunCommands'] || 'Auto Run Commands', getFeatureStatus(userInfo.allowAutoRunCommands))}
                    ${createDetailItem(i18n['profile.expBrowserFeatures'] || 'Exp. Browser Features', getFeatureStatus(userInfo.allowBrowserExperimentalFeatures))}
                </div>
                ${upgradeHtml}
            </div>

            <div class="profile-toggle">
                <button class="btn-text" id="profile-toggle-btn">
                    <span id="profile-toggle-text">${toggleText}</span> 
                    <span id="profile-toggle-icon" style="transform: ${iconTransform}">▼</span>
                </button>
            </div>
        `;
        dashboard.appendChild(card);
        
        // Bind event listeners after element creation
        const toggleBtn = card.querySelector('#profile-toggle-btn');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', toggleProfileDetails);
        }
        
        const maskBtn = card.querySelector('#profile-mask-btn');
        if (maskBtn) {
            maskBtn.addEventListener('click', () => {
                isDataMasked = !isDataMasked;
                // 发送消息到扩展，持久化存储到配置
                vscode.postMessage({ command: 'updateDataMasked', dataMasked: isDataMasked });
            });
        }
    }

    // Toggle detailed profile info
    function toggleProfileDetails() {
        const details = document.getElementById('profile-more');
        const text = document.getElementById('profile-toggle-text');
        const icon = document.getElementById('profile-toggle-icon');
        
        if (details.classList.contains('hidden')) {
            details.classList.remove('hidden');
            text.textContent = i18n['profile.less'] || 'Show Less';
            icon.style.transform = 'rotate(180deg)';
            isProfileExpanded = true;
        } else {
            details.classList.add('hidden');
            text.textContent = i18n['profile.more'] || 'Show More Details';
            icon.style.transform = 'rotate(0deg)';
            isProfileExpanded = false;
        }
    };

    function createDetailItem(label, value) {
        return `
            <div class="detail-item">
                <span class="detail-label">${label}</span>
                <span class="detail-value">${value}</span>
            </div>
        `;
    }

    // ============ 富文本工具提示 ============

    function initRichTooltip() {
        const tooltip = document.createElement('div');
        tooltip.className = 'rich-tooltip hidden';
        document.body.appendChild(tooltip);

        let activeTarget = null;

        document.addEventListener('mouseover', (e) => {
            const target = e.target.closest('[data-tooltip-html]');
            if (target && target !== activeTarget) {
                activeTarget = target;
                const html = target.getAttribute('data-tooltip-html');
                
                // 解码 HTML
                const decodedHtml = decodeURIComponent(html);
                
                tooltip.innerHTML = decodedHtml;
                tooltip.classList.remove('hidden');
                
                const rect = target.getBoundingClientRect();
                const tooltipRect = tooltip.getBoundingClientRect();
                
                // 计算位置：默认在下方，如果下方空间不足则在上方
                let top = rect.bottom + 8;
                let left = rect.left + (rect.width - tooltipRect.width) / 2;
                
                // 边界检查
                if (top + tooltipRect.height > window.innerHeight) {
                    top = rect.top - tooltipRect.height - 8;
                }
                if (left < 10) left = 10;
                if (left + tooltipRect.width > window.innerWidth - 10) {
                    left = window.innerWidth - tooltipRect.width - 10;
                }

                tooltip.style.top = top + 'px';
                tooltip.style.left = left + 'px';
            }
        });

        document.addEventListener('mouseout', (e) => {
            const target = e.target.closest('[data-tooltip-html]');
            if (target && target === activeTarget) {
                activeTarget = null;
                tooltip.classList.add('hidden');
            }
        });
        
        // 滚动时隐藏
        window.addEventListener('scroll', () => {
             if (activeTarget) {
                activeTarget = null;
                tooltip.classList.add('hidden');
             }
        }, true);
    }

    function escapeHtml(unsafe) {
        return unsafe
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
    }

    /**
     * 解析模型能力，返回能力列表
     */
    function getModelCapabilityList(model) {
        const caps = [];
        const mime = model.supportedMimeTypes || {};
        
        // 1. 图片能力
        if (model.supportsImages || Object.keys(mime).some(k => k.startsWith('image/'))) {
            caps.push({
                icon: '🖼️',
                text: i18n['capability.vision'] || 'Vision'
            });
        }
        
        // 2. 文档能力
        if (mime['application/pdf'] || mime['text/plain'] || mime['application/rtf']) {
            caps.push({
                icon: '📄',
                text: i18n['capability.docs'] || 'Documents'
            });
        }
        
        // 3. 音视频能力
        if (Object.keys(mime).some(k => k.startsWith('video/') || k.startsWith('audio/'))) {
            caps.push({
                icon: '🎬',
                text: i18n['capability.media'] || 'Media'
            });
        }
        
        return caps;
    }

    /**
     * 生成能力 Tooltip HTML
     */
    function generateCapabilityTooltip(caps) {
        return caps.map(cap => 
            `<div class="rich-tooltip-item ${cap.className || ''}"><span class="icon">${cap.icon}</span><span class="text">${cap.text}</span></div>`
        ).join('');
    }

    function renderGroupCard(group, pinnedGroups) {
        const pct = group.remainingPercentage || 0;
        const color = getHealthColor(pct);
        const isPinned = pinnedGroups && pinnedGroups.includes(group.groupId);
        
        const card = document.createElement('div');
        card.className = 'card group-card draggable';
        card.setAttribute('data-id', group.groupId);
        card.setAttribute('data-group-id', group.groupId);
        card.setAttribute('draggable', 'true');

        // 绑定拖拽事件
        card.addEventListener('dragstart', handleDragStart, false);
        card.addEventListener('dragenter', handleDragEnter, false);
        card.addEventListener('dragover', handleDragOver, false);
        card.addEventListener('dragleave', handleDragLeave, false);
        card.addEventListener('drop', handleDrop, false);
        card.addEventListener('dragend', handleDragEnd, false);

        // 生成组内模型列表（带能力图标）
        const modelList = group.models.map(m => {
            const caps = getModelCapabilityList(m);
            const tagHtml = m.tagTitle ? `<span class="tag-new">${m.tagTitle}</span>` : '';
            const recClass = m.isRecommended ? ' recommended' : '';
            
            // 如果有能力，添加悬浮属性
            let tooltipAttr = '';
            let capsIndicator = '';
            if (caps.length > 0) {
                const tooltipHtml = encodeURIComponent(generateCapabilityTooltip(caps));
                tooltipAttr = ` data-tooltip-html="${tooltipHtml}"`;
                capsIndicator = `<span class="caps-dot">✨</span>`;
            }

            return `<span class="group-model-tag${recClass}" title="${m.modelId}"${tooltipAttr}>${m.label}${tagHtml}${capsIndicator}</span>`;
        }).join('');

        card.innerHTML = `
            <div class="card-title">
                <span class="drag-handle" data-tooltip="${i18n['dashboard.dragHint'] || 'Drag to reorder'}">⋮⋮</span>
                <span class="group-icon">📦</span>
                <span class="label group-name">${group.groupName}</span>
                <div class="actions">
                    <button class="rename-group-btn icon-btn" data-group-id="${group.groupId}" data-tooltip-html="${encodeURIComponent('<div class="rich-tooltip-item"><span class="text">' + (i18n['grouping.rename'] || 'Rename') + '</span></div>')}">✏️</button>
                    <label class="switch" data-tooltip-html="${encodeURIComponent('<div class="rich-tooltip-item"><span class="text">' + (i18n['dashboard.pinHint'] || 'Pin to Status Bar') + '</span></div>')}">
                        <input type="checkbox" class="group-pin-toggle" data-group-id="${group.groupId}" ${isPinned ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                    <span class="status-dot" style="background-color: ${color}"></span>
                </div>
            </div>
            <div class="progress-circle" style="background: conic-gradient(${color} ${pct}%, var(--border-color) ${pct}%);">
                <div class="percentage">${pct.toFixed(2)}%</div>
            </div>
            <div class="info-row">
                <span>${i18n['dashboard.resetIn'] || 'Reset In'}</span>
                <span class="info-value">${group.timeUntilResetFormatted}</span>
            </div>
            <div class="info-row">
                <span>${i18n['dashboard.resetTime'] || 'Reset Time'}</span>
                <span class="info-value small">${group.resetTimeDisplay || 'N/A'}</span>
            </div>
            <div class="info-row">
                <span>${i18n['dashboard.status'] || 'Status'}</span>
                <span class="info-value" style="color: ${color}">
                    ${getStatusText(pct)}
                </span>
            </div>
            <div class="group-models">
                <div class="group-models-label">${i18n['grouping.models'] || 'Models'} (${group.models.length}):</div>
                <div class="group-models-list">${modelList}</div>
            </div>
        `;
        
        // 绑定重命名按钮事件 - 打开模态框
        const renameBtn = card.querySelector('.rename-group-btn');
        if (renameBtn) {
            renameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openRenameModal(
                    group.groupId,
                    group.groupName,
                    group.models.map(m => m.modelId)
                );
            });
        }
        
        // 绑定 pin 开关事件
        const pinToggle = card.querySelector('.group-pin-toggle');
        if (pinToggle) {
            pinToggle.addEventListener('change', (e) => {
                vscode.postMessage({ 
                    command: 'toggleGroupPin', 
                    groupId: group.groupId
                });
            });
        }
        
        dashboard.appendChild(card);
    }

    function renderModelCard(model, pinnedModels, modelCustomNames) {
        const pct = model.remainingPercentage || 0;
        const color = getHealthColor(pct);
        const isPinned = pinnedModels.includes(model.modelId);
        
        // 获取自定义名称，如果没有则使用原始 label
        const displayName = (modelCustomNames && modelCustomNames[model.modelId]) || model.label;
        const originalLabel = model.label;
        
        // 生成能力数据
        const caps = getModelCapabilityList(model);
        let capsIconHtml = '';
        let tooltipAttr = '';
        
        // 如果有能力，生成标题栏图标，并设置 tooltip
        if (caps.length > 0) {
            const tooltipHtml = encodeURIComponent(generateCapabilityTooltip(caps));
            tooltipAttr = ` data-tooltip-html="${tooltipHtml}"`;
            capsIconHtml = `<span class="title-caps-trigger">✨</span>`;
        }
        
        // 生成 New 标签
        const tagHtml = model.tagTitle ? `<span class="tag-new">${model.tagTitle}</span>` : '';
        
        // 推荐模型高亮样式
        const recommendedClass = model.isRecommended ? ' card-recommended' : '';

        const card = document.createElement('div');
        card.className = `card draggable${recommendedClass}`;
        card.setAttribute('draggable', 'true');
        card.setAttribute('data-id', model.modelId);

        // 绑定拖拽事件
        card.addEventListener('dragstart', handleDragStart, false);
        card.addEventListener('dragenter', handleDragEnter, false);
        card.addEventListener('dragover', handleDragOver, false);
        card.addEventListener('dragleave', handleDragLeave, false);
        card.addEventListener('drop', handleDrop, false);
        card.addEventListener('dragend', handleDragEnd, false);

        card.innerHTML = `
            <div class="card-title">
                <span class="drag-handle" data-tooltip="${i18n['dashboard.dragHint'] || 'Drag to reorder'}">⋮⋮</span>
                <div class="title-wrapper"${tooltipAttr}>
                    <span class="label model-name" title="${model.modelId} (${originalLabel})">${displayName}</span>
                    ${tagHtml}
                    ${capsIconHtml}
                </div>
                <div class="actions">
                    <button class="rename-model-btn icon-btn" data-model-id="${model.modelId}" data-tooltip-html="${encodeURIComponent('<div class="rich-tooltip-item"><span class="text">' + (i18n['model.rename'] || 'Rename') + '</span></div>')}">✏️</button>
                    <label class="switch" data-tooltip-html="${encodeURIComponent('<div class="rich-tooltip-item"><span class="text">' + (i18n['dashboard.pinHint'] || 'Pin to Status Bar') + '</span></div>')}">
                        <input type="checkbox" class="pin-toggle" data-model-id="${model.modelId}" ${isPinned ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                    <span class="status-dot" style="background-color: ${color}"></span>
                </div>
            </div>
            <div class="progress-circle" style="background: conic-gradient(${color} ${pct}%, var(--border-color) ${pct}%);">
                <div class="percentage">${pct.toFixed(2)}%</div>
            </div>
            <div class="info-row">
                <span>${i18n['dashboard.resetIn'] || 'Reset In'}</span>
                <span class="info-value">${model.timeUntilResetFormatted}</span>
            </div>
            <div class="info-row">
                <span>${i18n['dashboard.resetTime'] || 'Reset Time'}</span>
                <span class="info-value small">${model.resetTimeDisplay || 'N/A'}</span>
            </div>
            <div class="info-row">
                <span>${i18n['dashboard.status'] || 'Status'}</span>
                <span class="info-value" style="color: ${color}">
                    ${getStatusText(pct)}
                </span>
            </div>
        `;
        
        // 绑定重命名按钮事件
        const renameBtn = card.querySelector('.rename-model-btn');
        if (renameBtn) {
            renameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openModelRenameModal(model.modelId, displayName, originalLabel);
            });
        }
        
        dashboard.appendChild(card);
    }

    // ============ 启动 ============

    init();

})();
