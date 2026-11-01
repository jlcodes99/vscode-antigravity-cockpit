/**
 * Antigravity Cockpit - Auto Trigger Tab JS (Compact Layout)
 * 自动触发功能的前端逻辑 - 紧凑布局版本
 */

(function () {
    'use strict';

    // 获取 VS Code API
    const vscode = window.__vscodeApi || (window.__vscodeApi = acquireVsCodeApi());

    // 国际化
    const i18n = window.__autoTriggerI18n || {};
    const t = (key) => i18n[key] || key;
    const authUi = window.AntigravityAuthUI
        ? (window.__authUi || (window.__authUi = new window.AntigravityAuthUI(vscode)))
        : null;

    const baseTimeOptions = ['06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'];

    // 状态
    let currentState = null;
    let availableModels = [];
    const blockedModelIds = new Set([
        'chat_20706',
        'chat_23310',
        'gemini-2.5-flash-thinking',
        'gemini-2.5-pro',
    ]);
    const blockedDisplayNames = new Set([
        'Gemini 2.5 Flash (Thinking)',
        'Gemini 2.5 Pro',
        'chat_20706',
        'chat_23310',
    ]);
    let selectedModels = [];  // 从 state.schedule.selectedModels 获取
    let selectedAccounts = [];  // 从 state.schedule.selectedAccounts 获取
    let availableAccounts = [];
    let activeAccountEmail = '';
    let antigravityToolsSyncEnabled = false;
    let testSelectedModels = [];
    let testSelectedAccounts = [];
    let riskConfirmPending = false;

    // 配置状态
    let configEnabled = false;
    let configTriggerMode = 'scheduled';
    let configMode = 'daily';
    let configDailyTimes = ['08:00'];
    let configWeeklyDays = [1, 2, 3, 4, 5];
    let configWeeklyTimes = ['08:00'];
    let configIntervalHours = 4;
    let configIntervalStart = '07:00';
    let configIntervalEnd = '22:00';
    let configMaxOutputTokens = 0;
    const baseDailyTimes = [...baseTimeOptions];
    const baseWeeklyTimes = [...baseTimeOptions];

    // 时段策略配置状态
    let configTimeWindowEnabled = false;
    let configTimeWindowStart = '09:00';
    let configTimeWindowEnd = '18:00';
    let configFallbackTimes = ['07:00'];
    let testMaxOutputTokens = 0;

    // ============ 初始化 ============

    function parseNonNegativeInt(value, fallback) {
        const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
        // Allow 0 as a valid value (means no limit)
        if (!Number.isFinite(parsed) || parsed < 0) {
            return fallback;
        }
        return Math.floor(parsed);
    }

    function setAntigravityToolsSyncEnabled(_enabled) {
        antigravityToolsSyncEnabled = false;
        if (authUi) {
            authUi.updateState(currentState?.authorization, false);
        } else {
            const checkbox = document.getElementById('at-antigravityTools-sync-checkbox');
            if (checkbox) {
                checkbox.checked = false;
            }
        }
    }

    function attachAntigravityToolsSyncActions() {
        const checkbox = document.getElementById('at-antigravityTools-sync-checkbox');
        const importBtn = document.getElementById('at-antigravityTools-import-btn');

        checkbox?.addEventListener('change', (e) => {
            const target = e.target;
            if (!(target instanceof HTMLInputElement)) {
                return;
            }
            target.checked = false;
            antigravityToolsSyncEnabled = false;
            vscode.postMessage({ command: 'antigravityToolsSync.toggle', enabled: false });
        });

        importBtn?.addEventListener('click', () => {
            vscode.postMessage({ command: 'antigravityToolsSync.import' });
        });
    }

    function init() {
        vscode.postMessage({ command: 'autoTrigger.getState' });
        bindEvents();
    }

    function bindEvents() {
        // 授权按钮
        document.getElementById('at-auth-btn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'autoTrigger.authorize' });
        });

        // 配置按钮
        document.getElementById('at-config-btn')?.addEventListener('click', openConfigModal);
        document.getElementById('at-config-close')?.addEventListener('click', closeConfigModal);
        document.getElementById('at-config-cancel')?.addEventListener('click', closeConfigModal);
        document.getElementById('at-config-save')?.addEventListener('click', saveConfig);

        // 测试按钮
        document.getElementById('at-test-btn')?.addEventListener('click', openTestModal);
        document.getElementById('at-test-close')?.addEventListener('click', closeTestModal);
        document.getElementById('at-test-cancel')?.addEventListener('click', closeTestModal);
        document.getElementById('at-test-run')?.addEventListener('click', requestTestRunWithRiskWarning);

        // 历史按钮
        document.getElementById('at-history-btn')?.addEventListener('click', openHistoryModal);
        document.getElementById('at-history-close')?.addEventListener('click', closeHistoryModal);

        // 取消授权确认弹框
        document.getElementById('at-revoke-close')?.addEventListener('click', closeRevokeModal);
        document.getElementById('at-revoke-cancel')?.addEventListener('click', closeRevokeModal);
        document.getElementById('at-revoke-confirm')?.addEventListener('click', confirmRevoke);

        // Clear History
        document.getElementById('at-history-clear')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'autoTrigger.clearHistory' });
            closeHistoryModal();
        });

        // 模式选择
        document.getElementById('at-mode-select')?.addEventListener('change', (e) => {
            configMode = e.target.value;
            updateModeConfigVisibility();
            updateTimeChips();
            updatePreview();
        });

        // 总开关
        document.getElementById('at-enable-schedule')?.addEventListener('change', (e) => {
            const target = e.target;
            if (!(target instanceof HTMLInputElement)) {
                return;
            }

            if (target.checked) {
                target.checked = false;
                configEnabled = false;
                updateConfigAvailability();
                requestRiskWarningConfirm('enable');
                return;
            }

            configEnabled = target.checked;
            updateConfigAvailability();
        });

        // 唤醒方式
        document.getElementById('at-trigger-mode-list')?.addEventListener('click', (e) => {
            const target = e.target.closest('.at-segment-btn');
            if (!target) return;
            const mode = target.dataset.mode;
            if (!mode) return;
            configTriggerMode = mode;
            updateTriggerModeSelection();
            updateTriggerModeVisibility();
            updatePreview();
        });

        // 时间选择 - Daily
        document.getElementById('at-daily-times')?.addEventListener('click', (e) => {
            if (e.target.classList.contains('at-chip')) {
                const time = e.target.dataset.time;
                toggleTimeSelection(time, 'daily');
                updatePreview();
            }
        });

        bindCustomTimeInput('at-daily-custom-time', 'at-daily-add-time', 'daily');

        // 时间选择 - Weekly
        document.getElementById('at-weekly-times')?.addEventListener('click', (e) => {
            if (e.target.classList.contains('at-chip')) {
                const time = e.target.dataset.time;
                toggleTimeSelection(time, 'weekly');
                updatePreview();
            }
        });

        bindCustomTimeInput('at-weekly-custom-time', 'at-weekly-add-time', 'weekly');

        // 星期选择
        document.getElementById('at-weekly-days')?.addEventListener('click', (e) => {
            if (e.target.classList.contains('at-chip')) {
                const day = parseInt(e.target.dataset.day, 10);
                toggleDaySelection(day);
                updatePreview();
            }
        });

        // 快捷按钮
        document.querySelectorAll('.at-quick-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = btn.dataset.preset;
                if (preset === 'workdays') configWeeklyDays = [1, 2, 3, 4, 5];
                else if (preset === 'weekend') configWeeklyDays = [0, 6];
                else if (preset === 'all') configWeeklyDays = [0, 1, 2, 3, 4, 5, 6];
                updateDayChips();
                updatePreview();
            });
        });

        // 间隔配置
        document.getElementById('at-interval-hours')?.addEventListener('change', (e) => {
            configIntervalHours = parseInt(e.target.value, 10) || 4;
            updatePreview();
        });
        document.getElementById('at-interval-start')?.addEventListener('change', (e) => {
            configIntervalStart = e.target.value;
            updatePreview();
        });
        document.getElementById('at-interval-end')?.addEventListener('change', (e) => {
            configIntervalEnd = e.target.value;
            updatePreview();
        });

        // Crontab 验证
        document.getElementById('at-crontab-validate')?.addEventListener('click', () => {
            const input = document.getElementById('at-crontab-input');
            const result = document.getElementById('at-crontab-result');
            if (input && result) {
                if (input.value.trim()) {
                    result.className = 'at-crontab-result';
                    result.style.color = 'var(--vscode-charts-green)';
                    result.textContent = t('autoTrigger.validateOnSave');
                } else {
                    result.className = 'at-crontab-result';
                    result.style.color = 'var(--vscode-errorForeground)';
                    result.textContent = t('autoTrigger.crontabEmpty');
                }
            }
        });

        // Crontab 输入监听
        document.getElementById('at-crontab-input')?.addEventListener('input', () => {
            if (configTriggerMode === 'crontab') {
                updatePreview();
            }
        });

        // 时段策略开关
        document.getElementById('at-time-window-enabled')?.addEventListener('change', (e) => {
            configTimeWindowEnabled = e.target.checked;
            updateTimeWindowConfigVisibility();
        });

        // 时段策略时间范围
        document.getElementById('at-time-window-start')?.addEventListener('change', (e) => {
            configTimeWindowStart = e.target.value;
        });
        document.getElementById('at-time-window-end')?.addEventListener('change', (e) => {
            configTimeWindowEnd = e.target.value;
        });

        // Fallback 时间选择
        document.getElementById('at-fallback-times')?.addEventListener('click', (e) => {
            if (e.target.classList.contains('at-chip')) {
                const time = e.target.dataset.time;
                toggleFallbackTimeSelection(time);
            }
        });

        // Fallback 自定义时间添加
        bindCustomTimeInput('at-fallback-custom-time', 'at-fallback-add-time', 'fallback');

        // 点击模态框外部关闭（重命名弹框除外）
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal && modal.id !== 'rename-modal') {
                    modal.classList.add('hidden');
                }
            });
        });
    }

    // ============ 模态框操作 ============

    function openConfigModal() {
        loadConfigFromState();
        renderConfigModels();
        updateModeConfigVisibility();
        updateTimeChips();
        updateDayChips();
        updateTriggerModeVisibility();
        updateConfigAvailability();
        updatePreview();
        document.getElementById('at-config-modal')?.classList.remove('hidden');
    }

    function closeConfigModal() {
        document.getElementById('at-config-modal')?.classList.add('hidden');
    }

    function openTestModal() {
        // 获取可用模型的 ID 列表
        const availableIds = availableModels.map(m => m.id);

        // 从 selectedModels 中过滤，只保留在可用模型列表中的
        const validSelected = selectedModels.filter(id => availableIds.includes(id));

        if (validSelected.length > 0) {
            testSelectedModels = [...validSelected];
        } else if (availableModels.length > 0) {
            // 如果没有有效选择，默认选中第一个可用模型
            testSelectedModels = [availableModels[0].id];
        } else {
            testSelectedModels = [];
        }

        if (testSelectedAccounts.length === 0 && activeAccountEmail) {
            testSelectedAccounts = [activeAccountEmail];
        }

        const testMaxOutputTokensInput = document.getElementById('at-test-max-output-tokens');
        if (testMaxOutputTokensInput) {
            const scheduleTokens = currentState?.schedule?.maxOutputTokens;
            testMaxOutputTokens = parseNonNegativeInt(scheduleTokens, configMaxOutputTokens);
            testMaxOutputTokensInput.value = String(testMaxOutputTokens);
        }

        renderTestModels();
        renderTestAccounts();
        document.getElementById('at-test-modal')?.classList.remove('hidden');
    }

    function closeTestModal() {
        document.getElementById('at-test-modal')?.classList.add('hidden');
    }

    function openHistoryModal() {
        renderHistory();
        document.getElementById('at-history-modal')?.classList.remove('hidden');
    }

    function closeHistoryModal() {
        document.getElementById('at-history-modal')?.classList.add('hidden');
    }

    let pendingRevokeEmail = '';
    let revokeModalDefaultText = '';

    function openRevokeModal() {
        const modal = document.getElementById('at-revoke-modal');
        if (!modal) return;
        const textEl = modal.querySelector('p');
        if (textEl && !revokeModalDefaultText) {
            revokeModalDefaultText = textEl.textContent || '';
        }
        if (!pendingRevokeEmail) {
            if (textEl) {
                textEl.textContent = revokeModalDefaultText || t('autoTrigger.revokeConfirm');
            }
        }
        modal.classList.remove('hidden');
    }

    function openRevokeModalForEmail(email) {
        pendingRevokeEmail = String(email || '');
        const modal = document.getElementById('at-revoke-modal');
        if (modal) {
            const textEl = modal.querySelector('p');
            if (textEl && !revokeModalDefaultText) {
                revokeModalDefaultText = textEl.textContent || '';
            }
            const confirmText = t('autoTrigger.confirmRemove') || t('autoTrigger.revokeConfirm');
            if (textEl) {
                textEl.textContent = confirmText.replace('{email}', pendingRevokeEmail);
            }
        }
        openRevokeModal();
    }

    function closeRevokeModal() {
        const modal = document.getElementById('at-revoke-modal');
        if (modal) {
            const textEl = modal.querySelector('p');
            if (textEl && revokeModalDefaultText) {
                textEl.textContent = revokeModalDefaultText;
            }
            modal.classList.add('hidden');
        }
        pendingRevokeEmail = '';
    }

    function confirmRevoke() {
        if (pendingRevokeEmail) {
            vscode.postMessage({ command: 'autoTrigger.removeAccount', email: pendingRevokeEmail });
        } else {
            vscode.postMessage({ command: 'autoTrigger.revoke' });
        }
        closeRevokeModal();
    }

    // ============ 配置操作 ============

    function loadConfigFromState() {
        if (!currentState?.schedule) return;

        const s = currentState.schedule;
        configEnabled = s.enabled || false;
        configMode = s.repeatMode || 'daily';
        configDailyTimes = s.dailyTimes || ['08:00'];
        configWeeklyDays = s.weeklyDays || [1, 2, 3, 4, 5];
        configWeeklyTimes = s.weeklyTimes || ['08:00'];
        configIntervalHours = s.intervalHours || 4;
        configIntervalStart = s.intervalStartTime || '07:00';
        configIntervalEnd = s.intervalEndTime || '22:00';
        selectedModels = s.selectedModels || ['gemini-3-flash'];
        if (Array.isArray(s.selectedAccounts)) {
            selectedAccounts = s.selectedAccounts.slice();
        }
        if (selectedAccounts.length === 0 && activeAccountEmail) {
            selectedAccounts = [activeAccountEmail];
        }

        document.getElementById('at-enable-schedule').checked = configEnabled;
        document.getElementById('at-mode-select').value = configMode;
        document.getElementById('at-interval-hours').value = String(configIntervalHours);
        document.getElementById('at-interval-start').value = configIntervalStart;

        // 唤醒方式
        if (s.wakeOnReset) {
            configTriggerMode = 'quota_reset';
        } else if (s.crontab) {
            configTriggerMode = 'crontab';
        } else {
            configTriggerMode = 'scheduled';
        }
        updateTriggerModeSelection();

        // 自定义唤醒词
        const customPromptInput = document.getElementById('at-custom-prompt');
        if (customPromptInput) {
            customPromptInput.value = s.customPrompt || '';
        }

        configMaxOutputTokens = parseNonNegativeInt(s.maxOutputTokens, 0);
        const maxOutputTokensInput = document.getElementById('at-max-output-tokens');
        if (maxOutputTokensInput) {
            maxOutputTokensInput.value = String(configMaxOutputTokens);
        }

        // 恢复 Crontab
        const crontabInput = document.getElementById('at-crontab-input');
        if (crontabInput) {
            crontabInput.value = s.crontab || '';
        }
        document.getElementById('at-interval-end').value = configIntervalEnd;

        // 恢复时段策略配置
        configTimeWindowEnabled = s.timeWindowEnabled || false;
        configTimeWindowStart = s.timeWindowStart || '09:00';
        configTimeWindowEnd = s.timeWindowEnd || '18:00';
        configFallbackTimes = s.fallbackTimes || ['07:00'];

        const timeWindowEnabledEl = document.getElementById('at-time-window-enabled');
        if (timeWindowEnabledEl) {
            timeWindowEnabledEl.checked = configTimeWindowEnabled;
        }
        const timeWindowStartEl = document.getElementById('at-time-window-start');
        if (timeWindowStartEl) {
            timeWindowStartEl.value = configTimeWindowStart;
        }
        const timeWindowEndEl = document.getElementById('at-time-window-end');
        if (timeWindowEndEl) {
            timeWindowEndEl.value = configTimeWindowEnd;
        }
        updateFallbackTimeChips();
        updateTimeWindowConfigVisibility();

        renderConfigAccounts();
    }

    function saveConfig() {
        const wakeOnReset = configTriggerMode === 'quota_reset';
        const isCrontabMode = configTriggerMode === 'crontab';
        const crontabValue = document.getElementById('at-crontab-input')?.value.trim() || '';
        if (configEnabled && isCrontabMode && !crontabValue) {
            const result = document.getElementById('at-crontab-result');
            if (result) {
                result.className = 'at-crontab-result';
                result.style.color = 'var(--vscode-errorForeground)';
                result.textContent = t('autoTrigger.crontabEmpty');
            }
            return;
        }

        // 保存时自动吸收当前输入框中的自定义时间，无需额外点击“添加”
        if (configTriggerMode === 'scheduled') {
            if (configMode === 'daily') {
                applyPendingCustomTime('at-daily-custom-time', 'daily');
            } else if (configMode === 'weekly') {
                applyPendingCustomTime('at-weekly-custom-time', 'weekly');
            }
        } else if (wakeOnReset && configTimeWindowEnabled) {
            applyPendingCustomTime('at-fallback-custom-time', 'fallback');
        }

        const maxOutputTokens = parseNonNegativeInt(
            document.getElementById('at-max-output-tokens')?.value,
            0,
        );
        configMaxOutputTokens = maxOutputTokens;

        const config = {
            enabled: configEnabled,
            repeatMode: configMode,
            dailyTimes: configDailyTimes,
            weeklyDays: configWeeklyDays,
            weeklyTimes: configWeeklyTimes,
            intervalHours: configIntervalHours,
            intervalStartTime: configIntervalStart,
            intervalEndTime: configIntervalEnd,
            selectedModels: selectedModels.length > 0 ? selectedModels : ['gemini-3-flash'],
            selectedAccounts: selectedAccounts.length > 0
                ? selectedAccounts
                : (activeAccountEmail ? [activeAccountEmail] : []),
            crontab: isCrontabMode ? (crontabValue || undefined) : undefined,
            wakeOnReset: wakeOnReset,
            customPrompt: document.getElementById('at-custom-prompt')?.value.trim() || undefined,
            maxOutputTokens: maxOutputTokens,
            // 时段策略配置
            timeWindowEnabled: wakeOnReset ? configTimeWindowEnabled : false,
            timeWindowStart: wakeOnReset && configTimeWindowEnabled ? configTimeWindowStart : undefined,
            timeWindowEnd: wakeOnReset && configTimeWindowEnabled ? configTimeWindowEnd : undefined,
            fallbackTimes: wakeOnReset && configTimeWindowEnabled && configFallbackTimes.length > 0
                ? configFallbackTimes
                : undefined,
        };

        vscode.postMessage({
            command: 'autoTrigger.saveSchedule',
            schedule: config,
        });

        closeConfigModal();
    }

    function requestRiskWarningConfirm(action) {
        if (riskConfirmPending) {
            return;
        }
        riskConfirmPending = true;
        vscode.postMessage({
            command: 'autoTrigger.confirmRisk',
            riskAction: action,
        });
    }

    function handleRiskConfirmResult(payload) {
        riskConfirmPending = false;
        const action = payload?.action;
        const confirmed = Boolean(payload?.confirmed);

        if (action === 'enable') {
            const enableInput = document.getElementById('at-enable-schedule');
            if (enableInput instanceof HTMLInputElement) {
                enableInput.checked = confirmed;
            }
            configEnabled = confirmed;
            updateConfigAvailability();
            return;
        }

        if (action === 'test' && confirmed) {
            runTest();
        }
    }

    function requestTestRunWithRiskWarning() {
        if (isTestRunning) {
            return;
        }
        requestRiskWarningConfirm('test');
    }

    let isTestRunning = false;  // 防止重复点击

    function getTestSelectedModelsFromDom() {
        const container = document.getElementById('at-test-models');
        if (!container) return [];
        return Array.from(container.querySelectorAll('.at-model-item.selected'))
            .map(el => el.dataset.model)
            .filter(Boolean);
    }

    function getTestSelectedAccountsFromDom() {
        const container = document.getElementById('at-test-accounts');
        if (!container) return [];
        return Array.from(container.querySelectorAll('.at-model-item.selected'))
            .map(el => el.dataset.email)
            .filter(Boolean);
    }

    function runTest() {
        if (isTestRunning) return;

        const pickedModels = getTestSelectedModelsFromDom();
        if (pickedModels.length > 0) {
            testSelectedModels = pickedModels;
        }

        if (testSelectedModels.length === 0) {
            // 使用第一个可用模型作为默认
            const defaultModel = availableModels.length > 0 ? availableModels[0].id : 'gemini-3-flash';
            testSelectedModels = [defaultModel];
        }

        const pickedAccounts = getTestSelectedAccountsFromDom();
        if (pickedAccounts.length > 0) {
            testSelectedAccounts = pickedAccounts;
        }
        if (testSelectedAccounts.length === 0 && activeAccountEmail) {
            testSelectedAccounts = [activeAccountEmail];
        }

        // 获取自定义唤醒词
        const customPrompt = document.getElementById('at-test-custom-prompt')?.value.trim() || undefined;
        const maxOutputTokens = parseNonNegativeInt(
            document.getElementById('at-test-max-output-tokens')?.value,
            configMaxOutputTokens,
        );
        testMaxOutputTokens = maxOutputTokens;

        // 设置加载状态
        isTestRunning = true;
        const runBtn = document.getElementById('at-test-run');
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.innerHTML = `<span class="at-spinner"></span> ${t('autoTrigger.testing')}`;
        }

        // 关闭弹窗
        closeTestModal();

        // 显示状态提示
        showTestingStatus();

        vscode.postMessage({
            command: 'autoTrigger.test',
            models: [...testSelectedModels],
            customPrompt: customPrompt,
            accounts: [...testSelectedAccounts],
            maxOutputTokens: maxOutputTokens,
        });
    }

    function showTestingStatus() {
        const statusCard = document.getElementById('at-status-card');
        if (!statusCard) return;

        // 添加测试中提示
        let testingBanner = document.getElementById('at-testing-banner');
        if (!testingBanner) {
            testingBanner = document.createElement('div');
            testingBanner.id = 'at-testing-banner';
            testingBanner.className = 'at-testing-banner';
            statusCard.insertBefore(testingBanner, statusCard.firstChild);
        }
        testingBanner.innerHTML = `<span class="at-spinner"></span> ${t('autoTrigger.testingPleaseWait')}`;
        testingBanner.classList.remove('hidden');
    }

    function hideTestingStatus() {
        const testingBanner = document.getElementById('at-testing-banner');
        if (testingBanner) {
            testingBanner.classList.add('hidden');
        }

        // 重置按钮状态
        isTestRunning = false;
        const runBtn = document.getElementById('at-test-run');
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.innerHTML = `🚀 ${t('autoTrigger.runTest')}`;
        }
    }

    // ============ UI 更新 ============

    function updateConfigAvailability() {
        const configBody = document.getElementById('at-wakeup-config-body');
        if (!configBody) return;
        configBody.classList.toggle('at-disabled', !configEnabled);
    }

    function updateTriggerModeVisibility() {
        const scheduleSection = document.getElementById('at-schedule-config-section');
        const crontabSection = document.getElementById('at-crontab-config-section');
        const quotaResetSection = document.getElementById('at-quota-reset-config-section');
        const customPromptSection = document.getElementById('at-custom-prompt-section');

        if (scheduleSection) {
            scheduleSection.classList.toggle('hidden', configTriggerMode !== 'scheduled');
        }
        if (crontabSection) {
            crontabSection.classList.toggle('hidden', configTriggerMode !== 'crontab');
        }
        if (quotaResetSection) {
            quotaResetSection.classList.toggle('hidden', configTriggerMode !== 'quota_reset');
        }
        if (customPromptSection) {
            customPromptSection.classList.remove('hidden');
        }
        updateTriggerModeSelection();
        if (configTriggerMode === 'scheduled') {
            updateModeConfigVisibility();
        }
        if (configTriggerMode === 'quota_reset') {
            updateTimeWindowConfigVisibility();
        }
    }

    function updateTriggerModeSelection() {
        const container = document.getElementById('at-trigger-mode-list');
        if (!container) return;
        container.querySelectorAll('.at-segment-btn').forEach(item => {
            const mode = item.dataset.mode;
            item.classList.toggle('selected', mode === configTriggerMode);
            item.setAttribute('aria-pressed', mode === configTriggerMode ? 'true' : 'false');
        });
    }

    function updateModeConfigVisibility() {
        document.getElementById('at-config-daily')?.classList.toggle('hidden', configMode !== 'daily');
        document.getElementById('at-config-weekly')?.classList.toggle('hidden', configMode !== 'weekly');
        document.getElementById('at-config-interval')?.classList.toggle('hidden', configMode !== 'interval');
    }

    function updateTimeChips() {
        const times = configMode === 'daily' ? configDailyTimes : configWeeklyTimes;
        const containerId = configMode === 'daily' ? 'at-daily-times' : 'at-weekly-times';
        const baseTimes = configMode === 'daily' ? baseDailyTimes : baseWeeklyTimes;
        const container = document.getElementById(containerId);
        if (!container) return;

        container.querySelectorAll('.at-chip[data-custom="true"]').forEach(chip => {
            if (!times.includes(chip.dataset.time)) {
                chip.remove();
            }
        });

        times.forEach(time => {
            if (!baseTimes.includes(time) && !container.querySelector(`.at-chip[data-time="${time}"]`)) {
                const chip = document.createElement('div');
                chip.className = 'at-chip at-chip-custom';
                chip.dataset.time = time;
                chip.dataset.custom = 'true';
                chip.textContent = time;
                container.appendChild(chip);
            }
        });

        container.querySelectorAll('.at-chip').forEach(chip => {
            chip.classList.toggle('selected', times.includes(chip.dataset.time));
        });
    }

    function updateDayChips() {
        document.querySelectorAll('#at-weekly-days .at-chip').forEach(chip => {
            const day = parseInt(chip.dataset.day, 10);
            chip.classList.toggle('selected', configWeeklyDays.includes(day));
        });
    }

    function toggleTimeSelection(time, mode) {
        const arr = mode === 'daily' ? configDailyTimes : configWeeklyTimes;
        const idx = arr.indexOf(time);
        if (idx >= 0) {
            // 允许在“已填写自定义时间但未点击添加”时移除最后一个固定时间
            if (arr.length > 1 || hasPendingCustomTime(mode)) {
                arr.splice(idx, 1);
            }
        } else {
            arr.push(time);
        }
        arr.sort();
        updateTimeChips();
    }

    function bindCustomTimeInput(inputId, buttonId, mode) {
        const input = document.getElementById(inputId);
        const button = document.getElementById(buttonId);
        if (!input || !button) return;

        const addTime = () => {
            const normalized = normalizeTimeInput(input.value);
            if (!normalized) return;
            addCustomTime(normalized, mode);
            input.value = '';
            updatePreview();
        };

        button.addEventListener('click', addTime);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addTime();
            }
        });
        if (mode === 'daily' || mode === 'weekly') {
            input.addEventListener('input', updatePreview);
            input.addEventListener('change', updatePreview);
        }
    }

    function normalizeTimeInput(value) {
        const trimmed = String(value || '').trim();
        if (!trimmed) return null;

        const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) return null;

        const hour = parseInt(match[1], 10);
        const minute = parseInt(match[2], 10);
        if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

        return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }

    function addCustomTime(time, mode) {
        let arr;
        if (mode === 'daily') {
            arr = configDailyTimes;
        } else if (mode === 'weekly') {
            arr = configWeeklyTimes;
        } else if (mode === 'fallback') {
            arr = configFallbackTimes;
        } else {
            return;
        }
        if (!arr.includes(time)) {
            arr.push(time);
            arr.sort();
        }
        if (mode === 'fallback') {
            updateFallbackTimeChips();
        } else {
            updateTimeChips();
        }
    }

    function applyPendingCustomTime(inputId, mode) {
        const input = document.getElementById(inputId);
        if (!input) return;

        const normalized = normalizeTimeInput(input.value);
        if (!normalized) return;

        addCustomTime(normalized, mode);
        input.value = '';
    }

    function hasPendingCustomTime(mode) {
        return Boolean(getPendingCustomTime(mode));
    }

    function getPendingCustomTime(mode) {
        let inputId = '';
        if (mode === 'daily') {
            inputId = 'at-daily-custom-time';
        } else if (mode === 'weekly') {
            inputId = 'at-weekly-custom-time';
        } else if (mode === 'fallback') {
            inputId = 'at-fallback-custom-time';
        } else {
            return null;
        }

        const input = document.getElementById(inputId);
        if (!input) return null;
        return normalizeTimeInput(input.value);
    }

    function getEffectiveTimesForPreview(mode) {
        const base = mode === 'daily' ? [...configDailyTimes] : [...configWeeklyTimes];
        if (configMode === mode) {
            const pending = getPendingCustomTime(mode);
            if (pending && !base.includes(pending)) {
                base.push(pending);
            }
        }
        return base.sort();
    }

    // ============ 时段策略相关函数 ============

    function updateTimeWindowConfigVisibility() {
        const timeWindowConfig = document.getElementById('at-time-window-config');
        if (timeWindowConfig) {
            timeWindowConfig.classList.toggle('hidden', !configTimeWindowEnabled);
        }
    }

    function toggleFallbackTimeSelection(time) {
        const idx = configFallbackTimes.indexOf(time);
        if (idx >= 0) {
            // 至少保留一个时间点
            if (configFallbackTimes.length > 1 || hasPendingCustomTime('fallback')) {
                configFallbackTimes.splice(idx, 1);
            }
        } else {
            configFallbackTimes.push(time);
        }
        configFallbackTimes.sort();
        updateFallbackTimeChips();
    }

    function updateFallbackTimeChips() {
        const container = document.getElementById('at-fallback-times');
        if (!container) return;

        // 确保常用时间点都有 chip（如果不在默认列表中则添加自定义 chip）
        const defaultTimes = ['06:00', '07:00', '08:00'];
        
        // 先移除旧的自定义 chip
        container.querySelectorAll('.at-chip[data-custom="true"]').forEach(chip => {
            if (!configFallbackTimes.includes(chip.dataset.time)) {
                chip.remove();
            }
        });

        // 添加不在默认列表里的自定义时间 chip
        configFallbackTimes.forEach(time => {
            if (!defaultTimes.includes(time) && !container.querySelector(`.at-chip[data-time="${time}"]`)) {
                const chip = document.createElement('div');
                chip.className = 'at-chip at-chip-custom';
                chip.dataset.time = time;
                chip.dataset.custom = 'true';
                chip.textContent = time;
                container.appendChild(chip);
            }
        });

        // 更新所有 chip 的选中状态
        container.querySelectorAll('.at-chip').forEach(chip => {
            chip.classList.toggle('selected', configFallbackTimes.includes(chip.dataset.time));
        });
    }

    function toggleDaySelection(day) {
        const idx = configWeeklyDays.indexOf(day);
        if (idx >= 0) {
            if (configWeeklyDays.length > 1) configWeeklyDays.splice(idx, 1);
        } else {
            configWeeklyDays.push(day);
        }
        updateDayChips();
    }

    function renderConfigModels() {
        const container = document.getElementById('at-config-models');
        if (!container) return;

        container.textContent = '';
        if (availableModels.length === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'at-no-data';
            emptyEl.textContent = t('autoTrigger.noModels');
            container.appendChild(emptyEl);
            return;
        }

        // availableModels 现在是 ModelInfo 对象数组: { id, displayName, modelConstant }
        availableModels.forEach(model => {
            const isSelected = selectedModels.includes(model.id);
            const item = document.createElement('div');
            item.className = `at-model-item ${isSelected ? 'selected' : ''}`;
            item.dataset.model = model.id;
            item.textContent = model.displayName;
            container.appendChild(item);
        });

        container.querySelectorAll('.at-model-item').forEach(item => {
            item.addEventListener('click', () => {
                const modelId = item.dataset.model;
                const idx = selectedModels.indexOf(modelId);
                if (idx >= 0) {
                    if (selectedModels.length > 1) {
                        selectedModels.splice(idx, 1);
                        item.classList.remove('selected');
                    }
                } else {
                    selectedModels.push(modelId);
                    item.classList.add('selected');
                }
            });
        });
    }

    function renderConfigAccounts() {
        const container = document.getElementById('at-config-accounts');
        if (!container) return;

        container.textContent = '';
        if (!availableAccounts || availableAccounts.length === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'at-no-data';
            emptyEl.textContent = t('autoTrigger.noAccounts');
            container.appendChild(emptyEl);
            return;
        }

        availableAccounts.forEach(email => {
            const isSelected = selectedAccounts.includes(email);
            const item = document.createElement('div');
            item.className = `at-model-item ${isSelected ? 'selected' : ''}`;
            item.dataset.email = email;
            item.textContent = email;
            container.appendChild(item);
        });

        container.querySelectorAll('.at-model-item').forEach(item => {
            item.addEventListener('click', () => {
                const email = item.dataset.email;
                const idx = selectedAccounts.indexOf(email);
                if (idx >= 0) {
                    if (selectedAccounts.length > 1) {
                        selectedAccounts.splice(idx, 1);
                        item.classList.remove('selected');
                    }
                } else {
                    selectedAccounts.push(email);
                    item.classList.add('selected');
                }
            });
        });
    }

    function renderTestModels() {
        const container = document.getElementById('at-test-models');
        if (!container) return;

        if (availableModels.length === 0) {
            container.innerHTML = `<div class="at-no-data">${t('autoTrigger.noModels')}</div>`;
            return;
        }

        container.innerHTML = availableModels.map(model => {
            const isSelected = testSelectedModels.includes(model.id);
            return `<div class="at-model-item ${isSelected ? 'selected' : ''}" data-model="${escapeHtml(model.id)}">${escapeHtml(model.displayName)}</div>`;
        }).join('');

        container.querySelectorAll('.at-model-item').forEach(item => {
            item.addEventListener('click', () => {
                const modelId = item.dataset.model;
                const idx = testSelectedModels.indexOf(modelId);
                if (idx >= 0) {
                    if (testSelectedModels.length > 1) {
                        testSelectedModels.splice(idx, 1);
                        item.classList.remove('selected');
                    }
                } else {
                    testSelectedModels.push(modelId);
                    item.classList.add('selected');
                }
            });
        });
    }

    function renderTestAccounts() {
        const container = document.getElementById('at-test-accounts');
        if (!container) return;

        if (!availableAccounts || availableAccounts.length === 0) {
            container.innerHTML = `<div class="at-no-data">${t('autoTrigger.noAccounts')}</div>`;
            return;
        }

        if (testSelectedAccounts.length === 0 && activeAccountEmail) {
            testSelectedAccounts = [activeAccountEmail];
        }

        container.textContent = '';
        availableAccounts.forEach(email => {
            const isSelected = testSelectedAccounts.includes(email);
            const item = document.createElement('div');
            item.className = `at-model-item ${isSelected ? 'selected' : ''}`;
            item.dataset.email = email;
            item.textContent = email;
            container.appendChild(item);
        });

        container.querySelectorAll('.at-model-item').forEach(item => {
            item.addEventListener('click', () => {
                const email = item.dataset.email;
                const idx = testSelectedAccounts.indexOf(email);
                if (idx >= 0) {
                    if (testSelectedAccounts.length > 1) {
                        testSelectedAccounts.splice(idx, 1);
                        item.classList.remove('selected');
                    }
                } else {
                    testSelectedAccounts.push(email);
                    item.classList.add('selected');
                }
            });
        });
    }

    function renderHistory() {
        const container = document.getElementById('at-history-list');
        if (!container) return;

        const triggers = currentState?.recentTriggers || [];

        container.textContent = '';
        if (triggers.length === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'at-no-data';
            emptyEl.textContent = t('autoTrigger.noHistory');
            container.appendChild(emptyEl);
            return;
        }

        triggers.forEach(trigger => {
            const date = new Date(trigger.timestamp);
            const timeStr = date.toLocaleString();
            const icon = trigger.success ? '✅' : '❌';
            const statusText = trigger.success ? t('autoTrigger.success') : t('autoTrigger.failed');

            let typeLabel = t('autoTrigger.typeManual');
            let typeClass = 'at-history-type-manual';
            if (trigger.triggerType === 'auto') {
                typeClass = 'at-history-type-auto';
                if (trigger.triggerSource === 'scheduled') {
                    typeLabel = t('autoTrigger.typeAutoScheduled');
                } else if (trigger.triggerSource === 'crontab') {
                    typeLabel = t('autoTrigger.typeAutoCrontab');
                } else if (trigger.triggerSource === 'quota_reset') {
                    typeLabel = t('autoTrigger.typeAutoQuotaReset');
                } else {
                    typeLabel = t('autoTrigger.typeAuto');
                }
            }

            const item = document.createElement('div');
            item.className = 'at-history-item';

            const iconEl = document.createElement('span');
            iconEl.className = 'at-history-icon';
            iconEl.textContent = icon;

            const info = document.createElement('div');
            info.className = 'at-history-info';

            const time = document.createElement('div');
            time.className = 'at-history-time';
            time.appendChild(document.createTextNode(timeStr));

            const typeBadge = document.createElement('span');
            typeBadge.className = `at-history-type-badge ${typeClass}`;
            typeBadge.textContent = typeLabel;
            time.appendChild(typeBadge);

            if (trigger.accountEmail) {
                const accountBadge = document.createElement('span');
                accountBadge.className = 'at-history-account';
                accountBadge.title = trigger.accountEmail;
                accountBadge.textContent = trigger.accountEmail;
                time.appendChild(accountBadge);
            }

            info.appendChild(time);

            if (trigger.prompt) {
                const prompt = document.createElement('div');
                prompt.className = 'at-history-prompt';
                prompt.textContent = trigger.prompt;
                info.appendChild(prompt);
            }

            if (trigger.message) {
                const response = document.createElement('div');
                response.className = 'at-history-response';
                response.appendChild(buildResponseMessageNodes(trigger.message));
                info.appendChild(response);
            }

            if (!trigger.prompt && !trigger.message) {
                const msg = document.createElement('div');
                msg.className = 'at-history-message';
                msg.textContent = statusText;
                info.appendChild(msg);
            }

            item.append(iconEl, info);

            if (trigger.duration) {
                const duration = document.createElement('span');
                duration.className = 'at-history-duration';
                duration.textContent = `${trigger.duration}ms`;
                item.appendChild(duration);
            }

            container.appendChild(item);
        });
    }

    // HTML 转义函数
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // 格式化回复消息，识别 [[模型名]] 标记并高亮
    function appendTextWithParagraphBreaks(container, text) {
        const parts = String(text || '').split(/\n\n/);
        parts.forEach((part, index) => {
            container.appendChild(document.createTextNode(part));
            if (index < parts.length - 1) {
                container.appendChild(document.createElement('br'));
                container.appendChild(document.createElement('br'));
            }
        });
    }

    function buildResponseMessageNodes(message) {
        const fragment = document.createDocumentFragment();
        if (!message) return fragment;

        const parts = String(message).split(/\[\[([^\]]+)\]\]/g);
        parts.forEach((part, index) => {
            if (index % 2 === 1) {
                const span = document.createElement('span');
                span.className = 'at-model-name';
                span.textContent = part;
                fragment.appendChild(span);
            } else {
                appendTextWithParagraphBreaks(fragment, part);
            }
        });
        return fragment;
    }

    function updatePreview() {
        if (configTriggerMode === 'quota_reset') return;

        const containerId = configTriggerMode === 'crontab'
            ? 'at-next-runs-crontab'
            : 'at-next-runs-scheduled';
        const container = document.getElementById(containerId);
        if (!container) return;

        if (configTriggerMode === 'crontab') {
            const crontabInput = document.getElementById('at-crontab-input');
            const crontab = crontabInput?.value?.trim();
            if (!crontab) {
                container.innerHTML = `<li>${t('autoTrigger.crontabEmpty')}</li>`;
                return;
            }
            // 使用 Crontab 计算预览
            const nextRuns = calculateCrontabNextRuns(crontab, 5);
            if (nextRuns.length === 0) {
                container.innerHTML = `<li style="color: var(--vscode-errorForeground)">无效的 Crontab 表达式</li>`;
                return;
            }
            container.innerHTML = nextRuns.map((date, idx) => {
                return `<li>${idx + 1}. ${formatDateTime(date)}</li>`;
            }).join('');
            return;
        }

        // 普通模式预览
        const config = {
            repeatMode: configMode,
            dailyTimes: getEffectiveTimesForPreview('daily'),
            weeklyDays: configWeeklyDays,
            weeklyTimes: getEffectiveTimesForPreview('weekly'),
            intervalHours: configIntervalHours,
            intervalStartTime: configIntervalStart,
            intervalEndTime: configIntervalEnd,
        };

        const nextRuns = calculateNextRuns(config, 5);

        if (nextRuns.length === 0) {
            container.innerHTML = `<li>${t('autoTrigger.selectTimeHint')}</li>`;
            return;
        }

        container.innerHTML = nextRuns.map((iso, idx) => {
            const date = new Date(iso);
            return `<li>${idx + 1}. ${formatDateTime(date)}</li>`;
        }).join('');
    }

    // 解析 Crontab 并计算下次运行时间（简化版）
    function calculateCrontabNextRuns(crontab, count) {
        try {
            const parts = crontab.split(/\s+/);
            if (parts.length < 5) return [];

            const [minute, hour, _dayOfMonth, _month, _dayOfWeek] = parts;
            const results = [];
            const now = new Date();

            // 简化解析：支持 * 和具体数值
            const parseField = (field, max) => {
                if (field === '*') return Array.from({ length: max + 1 }, (_, i) => i);
                if (field.includes(',')) return field.split(',').map(Number);
                if (field.includes('-')) {
                    const [start, end] = field.split('-').map(Number);
                    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
                }
                if (field.includes('/')) {
                    const [, step] = field.split('/');
                    return Array.from({ length: Math.ceil(max / Number(step)) }, (_, i) => i * Number(step));
                }
                return [Number(field)];
            };

            const minutes = parseField(minute, 59);
            const hours = parseField(hour, 23);

            // 遍历未来 7 天
            for (let dayOffset = 0; dayOffset < 7 && results.length < count; dayOffset++) {
                for (const h of hours) {
                    for (const m of minutes) {
                        const date = new Date(now);
                        date.setDate(date.getDate() + dayOffset);
                        date.setHours(h, m, 0, 0);
                        if (date > now) {
                            results.push(date);
                            if (results.length >= count) break;
                        }
                    }
                    if (results.length >= count) break;
                }
            }

            return results;
        } catch {
            return [];
        }
    }

    function calculateNextRuns(config, count) {
        const now = new Date();
        const results = [];

        if (config.repeatMode === 'daily' && config.dailyTimes?.length) {
            for (let dayOffset = 0; dayOffset < 7 && results.length < count; dayOffset++) {
                for (const time of config.dailyTimes.sort()) {
                    const [h, m] = time.split(':').map(Number);
                    const date = new Date(now);
                    date.setDate(date.getDate() + dayOffset);
                    date.setHours(h, m, 0, 0);
                    if (date > now) {
                        results.push(date.toISOString());
                        if (results.length >= count) break;
                    }
                }
            }
        } else if (config.repeatMode === 'weekly' && config.weeklyDays?.length && config.weeklyTimes?.length) {
            for (let dayOffset = 0; dayOffset < 14 && results.length < count; dayOffset++) {
                const date = new Date(now);
                date.setDate(date.getDate() + dayOffset);
                const dayOfWeek = date.getDay();
                if (config.weeklyDays.includes(dayOfWeek)) {
                    for (const time of config.weeklyTimes.sort()) {
                        const [h, m] = time.split(':').map(Number);
                        date.setHours(h, m, 0, 0);
                        if (date > now) {
                            results.push(date.toISOString());
                            if (results.length >= count) break;
                        }
                    }
                }
            }
        } else if (config.repeatMode === 'interval') {
            const [startH, startM] = (config.intervalStartTime || '07:00').split(':').map(Number);
            const endH = config.intervalEndTime ? parseInt(config.intervalEndTime.split(':')[0], 10) : 22;
            const interval = config.intervalHours || 4;

            for (let dayOffset = 0; dayOffset < 7 && results.length < count; dayOffset++) {
                for (let h = startH; h <= endH; h += interval) {
                    const date = new Date(now);
                    date.setDate(date.getDate() + dayOffset);
                    date.setHours(h, startM, 0, 0);
                    if (date > now) {
                        results.push(date.toISOString());
                        if (results.length >= count) break;
                    }
                }
            }
        }

        return results.slice(0, count);
    }

    function formatDateTime(date) {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

        if (date.toDateString() === now.toDateString()) {
            return `${t('time.today')} ${timeStr}`;
        } else if (date.toDateString() === tomorrow.toDateString()) {
            return `${t('time.tomorrow')} ${timeStr}`;
        } else {
            const dayKeys = ['time.sunday', 'time.monday', 'time.tuesday', 'time.wednesday',
                'time.thursday', 'time.friday', 'time.saturday'];
            return `${t(dayKeys[date.getDay()])} ${timeStr}`;
        }
    }

    // ============ 状态更新 ============

    function updateState(state) {
        currentState = state;
        availableModels = filterAvailableModels(state.availableModels || []);

        if (state.schedule?.selectedModels) {
            selectedModels = state.schedule.selectedModels;
        }
        const accounts = state.authorization?.accounts || [];
        availableAccounts = accounts.map(acc => acc.email).filter(Boolean);
        activeAccountEmail = state.authorization?.activeAccount || state.authorization?.email || availableAccounts[0] || '';
        if (Array.isArray(state.schedule?.selectedAccounts)) {
            selectedAccounts = state.schedule.selectedAccounts.filter(email => availableAccounts.includes(email));
        } else if (activeAccountEmail) {
            selectedAccounts = [activeAccountEmail];
        }

        if (Array.isArray(testSelectedAccounts) && testSelectedAccounts.length > 0) {
            testSelectedAccounts = testSelectedAccounts.filter(email => availableAccounts.includes(email));
        } else if (activeAccountEmail) {
            testSelectedAccounts = [activeAccountEmail];
        }

        if (Array.isArray(state.schedule?.selectedModels)) {
            const currentSelected = state.schedule.selectedModels;
            selectedModels = currentSelected.filter(id => availableModels.some(model => model.id === id));
        } else if (availableModels.length > 0) {
            selectedModels = [availableModels[0].id];
        }

        // 隐藏测试中状态（如果收到新状态说明测试完成了）
        hideTestingStatus();

        updateAuthUI(state.authorization);
        updateStatusUI(state);
        updateHistoryCount(state.recentTriggers?.length || 0);
        renderConfigAccounts();
    }

    function filterAvailableModels(models) {
        if (!Array.isArray(models) || models.length === 0) {
            return [];
        }
        const filtered = [];
        for (const model of models) {
            const name = model.displayName || model.id;
            const blockedById = blockedModelIds.has(model.id);
            const blockedByName = blockedDisplayNames.has(name);
            if (blockedById || blockedByName) {
                if (blockedByName && !blockedById) {
                    console.info('[AutoTrigger] Hidden model by name, please confirm ID:', {
                        id: model.id,
                        displayName: model.displayName,
                    });
                }
                continue;
            }
            filtered.push(model);
        }
        return filtered;
    }

    function updateAuthUI(auth) {
        const authRow = document.getElementById('at-auth-row');
        const statusCard = document.getElementById('at-status-card');
        const statusGrid = document.getElementById('at-status-grid');
        const actions = document.getElementById('at-actions');

        if (!authRow) return;

        const accounts = auth?.accounts || [];
        const hasAccounts = accounts.length > 0;
        const isAuthorized = hasAccounts || auth?.isAuthorized;

        if (authUi) {
            authUi.updateState(auth, antigravityToolsSyncEnabled);
            authUi.renderAuthRow(authRow, { showSyncToggleInline: false });
        } else {
            const activeAccount = auth?.activeAccount;
            const activeEmail = activeAccount || auth?.email || (hasAccounts ? accounts[0].email : '');
            const syncToggle = document.createElement('label');
            syncToggle.className = 'antigravityTools-sync-toggle';
            const syncInput = document.createElement('input');
            syncInput.type = 'checkbox';
            syncInput.id = 'at-antigravityTools-sync-checkbox';
            syncInput.checked = false;
            const syncText = document.createElement('span');
            syncText.textContent = t('autoTrigger.antigravityToolsSync');
            syncToggle.append(syncInput, syncText);

            const importBtn = document.createElement('button');
            importBtn.id = 'at-antigravityTools-import-btn';
            importBtn.className = 'at-btn at-btn-secondary';
            importBtn.textContent = t('autoTrigger.importFromAntigravityTools');

            if (isAuthorized) {
                const extraCount = Math.max(accounts.length - 1, 0);
                authRow.textContent = '';

                const info = document.createElement('div');
                info.className = 'quota-auth-info quota-auth-info-clickable';
                info.title = t('autoTrigger.manageAccounts');

                const icon = document.createElement('span');
                icon.className = 'at-auth-icon';
                icon.textContent = '✅';
                const text = document.createElement('span');
                text.className = 'at-auth-text';
                text.textContent = t('autoTrigger.authorized');
                const emailEl = document.createElement('span');
                emailEl.className = 'quota-auth-email';
                emailEl.textContent = activeEmail;

                info.append(icon, text, emailEl);

                if (extraCount > 0) {
                    const badge = document.createElement('span');
                    badge.className = 'account-count-badge';
                    badge.title = t('autoTrigger.manageAccounts');
                    badge.textContent = `+${extraCount}`;
                    info.appendChild(badge);
                }

                if (accounts.length > 0) {
                    const manageBtn = document.createElement('button');
                    manageBtn.id = 'at-account-manage-btn';
                    manageBtn.className = 'quota-account-manage-btn';
                    manageBtn.title = t('autoTrigger.manageAccounts');
                    manageBtn.textContent = t('autoTrigger.manageAccounts');
                    info.appendChild(manageBtn);
                }

                const actions = document.createElement('div');
                actions.className = 'quota-auth-actions at-auth-actions';
                actions.append(syncToggle, importBtn);

                authRow.append(info, actions);

                // 点击授权信息区域打开账号管理弹框
                authRow.querySelector('.quota-auth-info')?.addEventListener('click', () => {
                    if (typeof window.openAccountManageModal === 'function') {
                        window.openAccountManageModal();
                    }
                });

                // 管理账号按钮
                document.getElementById('at-account-manage-btn')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (typeof window.openAccountManageModal === 'function') {
                        window.openAccountManageModal();
                    }
                });
                attachAntigravityToolsSyncActions();
            } else {
                // No accounts - show authorize button
                authRow.textContent = '';

                const info = document.createElement('div');
                info.className = 'quota-auth-info';
                const icon = document.createElement('span');
                icon.className = 'at-auth-icon';
                icon.textContent = '⚠️';
                const text = document.createElement('span');
                text.className = 'at-auth-text';
                text.textContent = t('autoTrigger.unauthorized');
                info.append(icon, text);

                const actions = document.createElement('div');
                actions.className = 'quota-auth-actions at-auth-actions';

                const authBtn = document.createElement('button');
                authBtn.id = 'at-auth-btn';
                authBtn.className = 'at-btn at-btn-primary';
                authBtn.textContent = t('autoTrigger.authorizeBtn');

                actions.append(syncToggle, importBtn, authBtn);
                authRow.append(info, actions);

                document.getElementById('at-auth-btn')?.addEventListener('click', () => {
                    vscode.postMessage({ command: 'autoTrigger.authorize' });
                });
                attachAntigravityToolsSyncActions();
            }
        }

        if (isAuthorized) {
            statusCard?.classList.remove('hidden');
            statusGrid?.classList.remove('hidden');
            actions?.classList.remove('hidden');
        } else {
            statusCard?.classList.add('hidden');
            statusGrid?.classList.add('hidden');
            actions?.classList.add('hidden');
        }
    }

    function updateStatusUI(state) {
        const schedule = state.schedule || {};

        // 状态
        const statusValue = document.getElementById('at-status-value');
        if (statusValue) {
            statusValue.textContent = schedule.enabled ? t('autoTrigger.enabled') : t('autoTrigger.disabled');
            statusValue.style.color = schedule.enabled ? 'var(--vscode-charts-green)' : '';
        }

        // 更新 Tab 状态点
        const tabDot = document.getElementById('at-tab-status-dot');
        if (tabDot) {
            // 只有在已授权且已启用的情况下显示状态点
            const isAuthorized = state.authorization?.isAuthorized;
            if (isAuthorized && schedule.enabled) {
                tabDot.classList.remove('hidden');
            } else {
                tabDot.classList.add('hidden');
            }
        }

        // 模式 - 支持 Crontab 和配额重置模式
        const modeValue = document.getElementById('at-mode-value');
        if (modeValue) {
            let modeText = '--';
            if (schedule.wakeOnReset) {
                // 配额重置模式
                modeText = `🔄 ${t('autoTrigger.modeQuotaReset')}`;
            } else if (schedule.crontab) {
                // Crontab 模式
                modeText = `Crontab: ${schedule.crontab}`;
            } else if (schedule.repeatMode === 'daily' && schedule.dailyTimes?.length) {
                // 显示所有时间点，最多 5 个
                const times = schedule.dailyTimes.slice(0, 5).join(', ');
                const suffix = schedule.dailyTimes.length > 5 ? '...' : '';
                modeText = `${t('autoTrigger.daily')} ${times}${suffix}`;
            } else if (schedule.repeatMode === 'weekly' && schedule.weeklyDays?.length) {
                // 显示选择的天和时间点（换行分开）
                const dayNames = [t('time.sunday'), t('time.monday'), t('time.tuesday'),
                t('time.wednesday'), t('time.thursday'), t('time.friday'), t('time.saturday')];
                const days = schedule.weeklyDays.map(d => dayNames[d] || d).join(', ');
                const times = schedule.weeklyTimes?.slice(0, 5).join(', ') || '';
                const timeSuffix = schedule.weeklyTimes?.length > 5 ? '...' : '';
                modeText = `${t('autoTrigger.weekly')} ${days}\n${times}${timeSuffix}`;
            } else if (schedule.repeatMode === 'interval') {
                modeText = `${t('autoTrigger.interval')} ${schedule.intervalHours || 4}h`;
            }
            modeValue.textContent = modeText;
        }

        // 模型 - 显示所有选中模型的完整名称
        const modelsValue = document.getElementById('at-models-value');
        if (modelsValue) {
            const modelIds = schedule.selectedModels || ['gemini-3-flash'];
            // 从 availableModels 中查找 displayName
            const getDisplayName = (id) => {
                const model = availableModels.find(m => m.id === id);
                return model?.displayName || id;
            };
            // 显示所有模型名称，用逗号分隔
            const allNames = modelIds.map(id => getDisplayName(id));
            modelsValue.textContent = allNames.join(', ');
        }

        // 账号 - 显示所有选中账号
        const accountsValue = document.getElementById('at-accounts-value');
        if (accountsValue) {
            const accountEmails = selectedAccounts;
            if (accountEmails.length === 0) {
                accountsValue.textContent = '--';
            } else if (accountEmails.length === 1) {
                accountsValue.textContent = accountEmails[0];
            } else {
                // 显示第一个账号 + 数量
                accountsValue.textContent = `${accountEmails[0]} (+${accountEmails.length - 1})`;
                accountsValue.title = accountEmails.join('\n');
            }
        }

        // 下次触发
        const nextValue = document.getElementById('at-next-value');
        if (nextValue) {
            // 配额重置模式下无法预测下次触发时间
            if (schedule.wakeOnReset) {
                nextValue.textContent = '--';
            } else if (schedule.enabled && state.nextTriggerTime) {
                // 使用正确的字段名 nextTriggerTime
                const nextDate = new Date(state.nextTriggerTime);
                nextValue.textContent = formatDateTime(nextDate);
            } else if (schedule.enabled && schedule.crontab) {
                // 如果有 Crontab，前端计算下次触发时间
                const nextRuns = calculateCrontabNextRuns(schedule.crontab, 1);
                if (nextRuns.length > 0) {
                    nextValue.textContent = formatDateTime(nextRuns[0]);
                } else {
                    nextValue.textContent = '--';
                }
            } else {
                nextValue.textContent = '--';
            }
        }
    }

    function updateHistoryCount(count) {
        const countEl = document.getElementById('at-history-count');
        if (countEl) {
            countEl.textContent = `(${count})`;
        }
    }

    // ============ 消息监听 ============

    window.addEventListener('message', event => {
        const message = event.data;

        switch (message.type) {
            case 'autoTriggerState':
                updateState(message.data);
                break;
            case 'telemetry_update':
                if (message.config?.antigravityToolsSyncEnabled !== undefined) {
                    setAntigravityToolsSyncEnabled(Boolean(message.config.antigravityToolsSyncEnabled));
                }
                break;
            case 'antigravityToolsSyncStatus':
                if (message.data?.enabled !== undefined) {
                    setAntigravityToolsSyncEnabled(Boolean(message.data.enabled));
                }
                if (message.data?.autoSyncEnabled !== undefined) {
                    setAntigravityToolsSyncEnabled(Boolean(message.data.autoSyncEnabled));
                }
                break;
            case 'autoTriggerRiskConfirmResult':
                handleRiskConfirmResult(message.data);
                break;
        }
    });

    // 导出
    window.AutoTriggerTab = {
        init,
        updateState,
    };
    window.openRevokeModalForEmail = openRevokeModalForEmail;

    // 初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
