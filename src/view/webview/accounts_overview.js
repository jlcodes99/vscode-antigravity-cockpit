/**
 * Antigravity Cockpit - 账号总览页面 JavaScript
 * 对齐 Cockpit Tools 账号总览交互
 */

// eslint-disable-next-line no-redeclare
/* global acquireVsCodeApi */

(function () {
    'use strict';

    const vscode = window.__vscodeApi || (window.__vscodeApi = acquireVsCodeApi());
    const strings = window.__accountsOverviewI18n || {};
    const i18n = window.__i18n || {};

    let accounts = [];
    let selected = new Set();
    let searchQuery = '';
    let filterType = 'all';
    let sortBy = 'overall';
    let sortDirection = 'desc'; // 'asc' or 'desc'
    let viewMode = 'grid';
    let sortGroups =  [];
    const resetSortPrefix = 'reset:'; // 重置时间排序前缀
    let currentConfig = {};
    let isInitialLoading = true;
    let actionMessageTimer = null;
    let renderToken = 0;
    let lastRenderOrder = [];
    let lastRenderViewMode = viewMode;
    let refreshCooldownTimer = null;
    const REFRESH_COOLDOWN_SECONDS = 10;
    let refreshAllLabel = '';
    const RENDER_BATCH_SIZE = 1;

    const elements = {
        backBtn: document.getElementById('ao-back-btn'),
        announcementBtn: document.getElementById('announcement-btn'),
        settingsBtn: document.getElementById('settings-btn'),
        totalAccounts: document.getElementById('ao-total-accounts'),
        currentAccount: document.getElementById('ao-current-account'),
        searchInput: document.getElementById('ao-search-input'),
        filterSelect: document.getElementById('ao-filter-select'),
        sortSelect: document.getElementById('ao-sort-select'),
        sortDirectionBtn: document.getElementById('ao-sort-direction-btn'),
        viewListBtn: document.getElementById('ao-view-list'),
        viewGridBtn: document.getElementById('ao-view-grid'),
        refreshAllBtn: document.getElementById('ao-refresh-all-btn'),
        addBtn: document.getElementById('ao-add-btn'),
        importBtn: document.getElementById('ao-import-btn'),
        exportBtn: document.getElementById('ao-export-btn'),
        deleteSelectedBtn: document.getElementById('ao-delete-selected-btn'),
        selectAll: document.getElementById('ao-select-all'),
        accountsGrid: document.getElementById('ao-accounts-grid'),
        accountsTable: document.getElementById('ao-accounts-table'),
        accountsTbody: document.getElementById('ao-accounts-tbody'),
        emptyState: document.getElementById('ao-empty-state'),
        emptyMatch: document.getElementById('ao-empty-match'),
        loading: document.getElementById('ao-loading'),
        addFirstBtn: document.getElementById('ao-add-first-btn'),
        actionMessage: document.getElementById('ao-action-message'),
        actionMessageText: document.getElementById('ao-action-message-text'),
        actionMessageClose: document.getElementById('ao-action-message-close'),
        addModal: document.getElementById('ao-add-modal'),
        addClose: document.getElementById('ao-add-close'),
        addTabs: document.querySelectorAll('.add-tab'),
        addPanels: document.querySelectorAll('.add-panel'),
        oauthStart: document.getElementById('ao-oauth-start'),
        oauthContinue: document.getElementById('ao-oauth-continue'),
        oauthLink: document.getElementById('ao-oauth-link'),
        oauthCopy: document.getElementById('ao-oauth-copy'),
        tokenInput: document.getElementById('ao-token-input'),
        tokenImport: document.getElementById('ao-token-import'),
        importLocal: document.getElementById('ao-import-local'),
        importTools: document.getElementById('ao-import-tools'),
        addFeedback: document.getElementById('ao-add-feedback'),
        confirmModal: document.getElementById('ao-confirm-modal'),
        confirmTitle: document.getElementById('ao-confirm-title'),
        confirmMessage: document.getElementById('ao-confirm-message'),
        confirmOk: document.getElementById('ao-confirm-ok'),
        confirmCancel: document.getElementById('ao-confirm-cancel'),
        confirmClose: document.getElementById('ao-confirm-close'),
        quotaModal: document.getElementById('ao-quota-modal'),
        quotaList: document.getElementById('ao-quota-list'),
        quotaClose: document.getElementById('ao-quota-close'),
        quotaCloseBtn: document.getElementById('ao-quota-close-btn'),
        quotaRefresh: document.getElementById('ao-quota-refresh'),
        quotaBadges: document.getElementById('ao-quota-badges'),
        toast: document.getElementById('toast'),
    };

    let addStatus = 'idle';
    let addMessage = '';
    let oauthUrl = '';
    let _oauthUrlCopied = false;
    let oauthPreparing = false;
    let confirmCallback = null;
    let currentQuotaEmail = null;

    // =====================================================================
    // Utilities
    // =====================================================================

    function getString(key, fallback) {
        return strings[key] || fallback;
    }

    function getI18n(key, fallback) {
        return i18n[key] || fallback;
    }

    function escapeHtml(value) {
        if (!value) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // 验证并清理 URL，防止 javascript: 等危险协议
    function sanitizeUrl(url) {
        if (!url || typeof url !== 'string') return '';
        const trimmed = url.trim();
        // 只允许 http, https, data (用于图片) 协议
        if (/^(https?:|data:image\/)/i.test(trimmed)) {
            return trimmed;
        }
        // 相对路径也允许
        if (trimmed.startsWith('/') || trimmed.startsWith('./')) {
            return trimmed;
        }
        return '';
    }

    // 安全的 CSS class 名称
    function sanitizeClassName(value) {
        if (!value || typeof value !== 'string') return '';
        return value.replace(/[^a-zA-Z0-9_-]/g, '');
    }

    function appendTextWithLineBreaks(container, text) {
        const lines = String(text || '').split('\n');
        lines.forEach((line, index) => {
            container.appendChild(document.createTextNode(line));
            if (index < lines.length - 1) {
                container.appendChild(document.createElement('br'));
            }
        });
    }

    function formatDate(timestamp) {
        if (!timestamp) return '-';
        const date = new Date(timestamp);
        return date.toLocaleString(undefined, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    function getQuotaClass(percentage) {
        if (percentage >= 70) return 'high';
        if (percentage >= 30) return 'medium';
        return 'low';
    }

    function getTierLabel(account) {
        const raw = (account.tier || '').trim();
        if (!raw) return '';
        const tier = raw.toUpperCase();
        if (tier === 'UNKNOWN' || tier === 'N/A') return '';
        if (tier.includes('ULTRA')) return 'ULTRA';
        if (tier.includes('PRO') || tier.includes('PREMIUM')) return 'PRO';
        if (tier.includes('FREE')) return 'FREE';
        return tier;
    }

    function getTierClass(label) {
        return label.toLowerCase();
    }

    function getAccountModels(account) {
        if (!account.groups || account.groups.length === 0) return [];
        const map = new Map();
        account.groups.forEach(group => {
            (group.models || []).forEach(model => {
                const key = model.modelId || model.label;
                if (!map.has(key) && typeof model.percentage === 'number') {
                    map.set(key, model.percentage);
                }
            });
        });
        return Array.from(map.values());
    }

    function getOverallQuota(account) {
        const values = getAccountModels(account);
        if (values.length > 0) {
            const sum = values.reduce((acc, v) => acc + v, 0);
            return Math.round(sum / values.length);
        }
        if (!account.groups || account.groups.length === 0) return 0;
        const groupValues = account.groups
            .map(group => group.percentage)
            .filter(v => typeof v === 'number');
        if (groupValues.length === 0) return 0;
        const sum = groupValues.reduce((acc, v) => acc + v, 0);
        return Math.round(sum / groupValues.length);
    }

    function getGroupQuota(account, groupId) {
        if (!account.groups) return 0;
        const group = account.groups.find(g => g.groupId === groupId);
        if (!group || typeof group.percentage !== 'number') return 0;
        return group.percentage;
    }

    /**
     * 获取分组的重置时间戳 (Unix timestamp in milliseconds)
     * @param {object} account - 账号对象
     * @param {string} groupId - 分组 ID
     * @returns {number|null} - 重置时间戳,如果无法解析则返回 null
     */
    function getGroupResetTimestamp(account, groupId) {
        if (!account.groups) return null;
        const group = account.groups.find(g => g.groupId === groupId);
        if (!group || !group.resetTime) return null;
        
        // resetTime 格式示例: "2024-02-05T12:00:00Z" 或其他 ISO 格式
        try {
            const timestamp = new Date(group.resetTime).getTime();
            return isNaN(timestamp) ? null : timestamp;
        } catch (e) {
            return null;
        }
    }

    function getDisplayGroups(account) {
        if (!account.groups || account.groups.length === 0) return [];
        const groups = [...account.groups];
        const order = Array.isArray(currentConfig.groupOrder) ? currentConfig.groupOrder : [];
        if (order.length > 0) {
            const orderMap = new Map(order.map((id, index) => [id, index]));
            groups.sort((a, b) => {
                const idxA = orderMap.has(a.groupId) ? orderMap.get(a.groupId) : 99999;
                const idxB = orderMap.has(b.groupId) ? orderMap.get(b.groupId) : 99999;
                if (idxA !== idxB) return idxA - idxB;
                return a.groupName.localeCompare(b.groupName);
            });
        } else {
            groups.sort((a, b) => a.groupName.localeCompare(b.groupName));
        }
        return groups.slice(0, 4);
    }

    function setViewMode(mode) {
        viewMode = mode;
        if (viewMode === 'list') {
            elements.viewListBtn.classList.add('active');
            elements.viewGridBtn.classList.remove('active');
        } else {
            elements.viewGridBtn.classList.add('active');
            elements.viewListBtn.classList.remove('active');
        }
        vscode.setState({ viewMode });
        render();
    }

    function showActionMessage(message, tone) {
        if (!elements.actionMessage || !elements.actionMessageText) return;
        elements.actionMessage.className = `action-message${tone ? ` ${tone}` : ''}`;
        elements.actionMessageText.textContent = message;
        elements.actionMessage.classList.remove('hidden');
        if (actionMessageTimer) {
            clearTimeout(actionMessageTimer);
        }
        actionMessageTimer = setTimeout(() => {
            elements.actionMessage.classList.add('hidden');
        }, 4000);
    }

    function hideActionMessage() {
        if (!elements.actionMessage) return;
        elements.actionMessage.classList.add('hidden');
    }

    function startRefreshCooldown(seconds) {
        if (!elements.refreshAllBtn) return;
        elements.refreshAllBtn.classList.add('loading');
        elements.refreshAllBtn.disabled = true;
        elements.refreshAllBtn.setAttribute('aria-disabled', 'true');

        let remaining = seconds;
        elements.refreshAllBtn.textContent = `${remaining}s`;

        if (refreshCooldownTimer) {
            clearInterval(refreshCooldownTimer);
        }

        refreshCooldownTimer = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
                clearInterval(refreshCooldownTimer);
                refreshCooldownTimer = null;
                elements.refreshAllBtn.classList.remove('loading');
                elements.refreshAllBtn.disabled = false;
                elements.refreshAllBtn.removeAttribute('aria-disabled');
                elements.refreshAllBtn.textContent = refreshAllLabel || getString('refreshAll', 'Refresh');
            } else {
                elements.refreshAllBtn.textContent = `${remaining}s`;
            }
        }, 1000);
    }

    // =====================================================================
    // Rendering
    // =====================================================================

    function updateSortOptions() {
        const groupMap = new Map();
        accounts.forEach(account => {
            (account.groups || []).forEach(group => {
                if (group.groupId && group.groupName) {
                    groupMap.set(group.groupId, group.groupName);
                }
            });
        });
        sortGroups = Array.from(groupMap.entries())
            .map(([id, name]) => ({ id, name }))
            .sort((a, b) => a.name.localeCompare(b.name));

        const currentValue = elements.sortSelect.value;
        // 添加基础排序选项
        elements.sortSelect.innerHTML = `
            <option value="overall">${escapeHtml(getString('sortOverall', 'Overall Quota'))}</option>
            <option value="last_updated">${escapeHtml(getString('sortByLastUpdated', 'By Update Time'))}</option>
        `;
        // 添加分组配额排序选项
        sortGroups.forEach(group => {
            const selected = currentValue === group.id ? 'selected' : '';
            elements.sortSelect.innerHTML += `<option value="${escapeHtml(group.id)}" ${selected}>${escapeHtml(getString('sortByGroup', 'By {group} Quota').replace('{group}', group.name))}</option>`;
        });
        // 添加分组重置时间排序选项
        sortGroups.forEach(group => {
            const resetValue = `${resetSortPrefix}${group.id}`;
            const selected = currentValue === resetValue ? 'selected' : '';
            elements.sortSelect.innerHTML += `<option value="${escapeHtml(resetValue)}" ${selected}>${escapeHtml(getString('sortByGroupReset', 'By {group} Reset Time').replace('{group}', group.name))}</option>`;
        });

        // Update sort direction button
        if (elements.sortDirectionBtn) {
            elements.sortDirectionBtn.textContent = sortDirection === 'asc' ? '⬆' : '⬇';
            elements.sortDirectionBtn.title = sortDirection === 'asc' 
                ? (getString('sortAsc', 'Ascending')) 
                : (getString('sortDesc', 'Descending'));
        }
    }

    function updateFilterOptions() {
        const counts = { all: accounts.length, PRO: 0, ULTRA: 0 };
        accounts.forEach(account => {
            const tier = getTierLabel(account);
            if (tier === 'PRO') counts.PRO += 1;
            else if (tier === 'ULTRA') counts.ULTRA += 1;
        });

        // 检查是否有任何有效的等级信息
        const hasTierInfo = counts.PRO > 0 || counts.ULTRA > 0;
        const filterContainer = elements.filterSelect?.parentElement;

        if (!hasTierInfo) {
            // 没有等级信息，隐藏筛选下拉框容器并重置为全部
            if (filterContainer) filterContainer.classList.add('hidden');
            filterType = 'all';
            return;
        }

        // 有等级信息，显示筛选下拉框容器
        if (filterContainer) filterContainer.classList.remove('hidden');
        elements.filterSelect.innerHTML = `
            <option value="all">${escapeHtml((getString('filterAll', 'All ({count})')).replace('{count}', counts.all))}</option>
            <option value="PRO">${escapeHtml((getString('filterPro', 'PRO ({count})')).replace('{count}', counts.PRO))}</option>
            <option value="ULTRA">${escapeHtml((getString('filterUltra', 'ULTRA ({count})')).replace('{count}', counts.ULTRA))}</option>
        `;
        elements.filterSelect.value = filterType;
    }

    function filterAndSortAccounts() {
        let result = [...accounts];

        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            result = result.filter(acc => acc.email.toLowerCase().includes(query));
        }

        if (filterType !== 'all') {
            result = result.filter(acc => getTierLabel(acc) === filterType);
        }

        const modifier = sortDirection === 'asc' ? -1 : 1;

        // 按更新时间排序 (使用 lastUpdated 作为创建时间的替代)
        if (sortBy === 'last_updated') {
            result.sort((a, b) => {
                const aTime = a.lastUpdated || 0;
                const bTime = b.lastUpdated || 0;
                return (bTime - aTime) * modifier;
            });
        }
        // 按分组重置时间排序
        else if (sortBy.startsWith(resetSortPrefix) && sortGroups.length > 0) {
            const targetGroupId = sortBy.slice(resetSortPrefix.length);
            const targetGroup = sortGroups.find(group => group.id === targetGroupId);
            if (targetGroup) {
                result.sort((a, b) => {
                    const aReset = getGroupResetTimestamp(a, targetGroupId);
                    const bReset = getGroupResetTimestamp(b, targetGroupId);
                    if (aReset === null && bReset === null) return 0;
                    if (aReset === null) return 1; // 无数据排后面
                    if (bReset === null) return -1;
                    return (bReset - aReset) * modifier;
                });
            }
        }
        // 按分组配额排序
        else if (sortBy !== 'overall' && sortGroups.some(group => group.id === sortBy)) {
            result.sort((a, b) => {
                const aGroup = getGroupQuota(a, sortBy);
                const bGroup = getGroupQuota(b, sortBy);
                if (aGroup !== bGroup) return (bGroup - aGroup) * modifier;
                return (getOverallQuota(b) - getOverallQuota(a)) * modifier;
            });
        }
        // 默认按综合配额排序
        else {
            result.sort((a, b) => (getOverallQuota(b) - getOverallQuota(a)) * modifier);
        }

        return result;
    }

    function renderQuotaGroups(account) {
        if (account.loading) {
            return `<div class="quota-empty">${escapeHtml(getString('loading', 'Loading...'))}</div>`;
        }
        if (account.error) {
            return `<div class="quota-empty quota-error">⚠️ ${escapeHtml(account.error)}</div>`;
        }

        const groups = getDisplayGroups(account);
        if (groups.length === 0) {
            return `<div class="quota-empty">${escapeHtml(getString('noQuotaData', 'No quota data'))}</div>`;
        }

        return groups.map(group => {
            const pct = Math.round(group.percentage || 0);
            const pctClass = getQuotaClass(pct);
            return `
                <div class="quota-compact-item">
                    <div class="quota-compact-header">
                        <span class="model-label">${escapeHtml(group.groupName)}</span>
                        <span class="model-pct ${pctClass}">${pct}%</span>
                    </div>
                    <div class="quota-compact-bar-track">
                        <div class="quota-compact-bar ${pctClass}" style="width: ${Math.min(100, pct)}%"></div>
                    </div>
                    ${group.resetTimeFormatted ? `<span class="quota-compact-reset">${escapeHtml(group.resetTimeFormatted)}</span>` : ''}
                </div>
            `;
        }).join('');
    }

    function renderAccountCard(account) {
        const tier = getTierLabel(account);
        const tierClass = getTierClass(tier);
        const tierBadge = tier ? `<span class="tier-badge ${tierClass}">${tier}</span>` : '';
        const isCurrent = account.isCurrent;
        const isSelected = selected.has(account.email);
        const fingerprintStatus = account.hasDeviceBound
            ? `${getString('bound', 'Bound')}`
            : `${getString('unbound', 'Unbound')}`;
        const fingerprintClass = account.hasDeviceBound ? 'bound' : 'unbound';

        return `
            <div class="account-card ${isCurrent ? 'current' : ''} ${isSelected ? 'selected' : ''}" data-email="${escapeHtml(account.email)}">
                <div class="card-top">
                    <div class="card-select">
                        <input type="checkbox" data-action="select" ${isSelected ? 'checked' : ''} data-email="${escapeHtml(account.email)}" />
                    </div>
                    <span class="account-email" title="${escapeHtml(account.email)}">${escapeHtml(account.email)}</span>
                    ${isCurrent ? `<span class="current-tag">${escapeHtml(getString('current', 'Current'))}</span>` : ''}
                    ${tierBadge}
                </div>

                <div class="card-quota-grid">
                    ${renderQuotaGroups(account)}
                </div>

                <div class="card-footer">
                    <div class="card-meta">
                        <span class="card-date">${escapeHtml(formatDate(account.lastUpdated))}</span>
                        <span class="fingerprint-pill ${fingerprintClass}">${escapeHtml(getString('fingerprint', 'Fingerprint'))}: ${fingerprintStatus}</span>
                    </div>
                    <div class="card-actions">
                        <button class="card-action-btn" data-action="details" data-email="${escapeHtml(account.email)}" title="${escapeHtml(getString('details', 'Details'))}">ℹ️</button>
                        ${isCurrent ? '' : `<button class="card-action-btn success" data-action="switch" data-email="${escapeHtml(account.email)}" title="${escapeHtml(getString('switch', 'Switch'))}">▶</button>`}
                        <button class="card-action-btn" data-action="refresh" data-email="${escapeHtml(account.email)}" title="${escapeHtml(getString('refresh', 'Refresh'))}">⟳</button>
                        <button class="card-action-btn export-btn" data-action="export" data-email="${escapeHtml(account.email)}" title="${escapeHtml(getString('export', 'Export'))}">⤴</button>
                        <button class="card-action-btn danger" data-action="delete" data-email="${escapeHtml(account.email)}" title="${escapeHtml(getString('delete', 'Delete'))}">🗑</button>
                    </div>
                </div>
            </div>
        `;
    }

    function renderAccountRow(account) {
        const tier = getTierLabel(account);
        const tierClass = getTierClass(tier);
        const tierBadge = tier ? `<span class="tier-badge ${tierClass}">${tier}</span>` : '';
        const isCurrent = account.isCurrent;
        const isSelected = selected.has(account.email);
        const fingerprintStatus = account.hasDeviceBound
            ? `${getString('bound', 'Bound')}`
            : `${getString('unbound', 'Unbound')}`;
        const fingerprintClass = account.hasDeviceBound ? 'bound' : 'unbound';

        const quotaContent = account.loading
            ? `<span class="quota-empty">${escapeHtml(getString('loading', 'Loading...'))}</span>`
            : account.error
                ? `<span class="quota-empty quota-error">⚠️ ${escapeHtml(account.error)}</span>`
                : renderQuotaGroups(account);

        return `
            <tr class="${isCurrent ? 'current' : ''}" data-email="${escapeHtml(account.email)}">
                <td>
                    <input type="checkbox" data-action="select" ${isSelected ? 'checked' : ''} data-email="${escapeHtml(account.email)}" />
                </td>
                <td>
                    <div class="account-cell">
                        <div class="account-main-line">
                            <span class="account-email-text" title="${escapeHtml(account.email)}">${escapeHtml(account.email)}</span>
                            ${isCurrent ? `<span class="mini-tag current">${escapeHtml(getString('current', 'Current'))}</span>` : ''}
                        </div>
                        <div class="account-sub-line">
                            ${tierBadge}
                        </div>
                    </div>
                </td>
                <td>
                    <span class="fingerprint-status ${fingerprintClass}">${escapeHtml(getString('fingerprint', 'Fingerprint'))}: ${fingerprintStatus}</span>
                </td>
                <td>
                    <div class="quota-grid">
                        ${quotaContent}
                    </div>
                </td>
                <td class="sticky-action-cell table-action-cell">
                    <div class="action-buttons">
                        <button class="action-btn" data-action="details" data-email="${escapeHtml(account.email)}" title="${escapeHtml(getString('details', 'Details'))}">ℹ️</button>
                        ${isCurrent ? '' : `<button class="action-btn success" data-action="switch" data-email="${escapeHtml(account.email)}" title="${escapeHtml(getString('switch', 'Switch'))}">▶</button>`}
                        <button class="action-btn" data-action="refresh" data-email="${escapeHtml(account.email)}" title="${escapeHtml(getString('refresh', 'Refresh'))}">⟳</button>
                        <button class="action-btn danger" data-action="delete" data-email="${escapeHtml(account.email)}" title="${escapeHtml(getString('delete', 'Delete'))}">🗑</button>
                    </div>
                </td>
            </tr>
        `;
    }

    function escapeCss(value) {
        if (window.CSS && typeof window.CSS.escape === 'function') {
            return window.CSS.escape(value);
        }
        return value.replace(/["\\]/g, '\\$&');
    }

    function getRenderOrder(items) {
        return items.map(item => item.email);
    }

    function isSameRenderOrder(nextOrder) {
        if (nextOrder.length !== lastRenderOrder.length) {
            return false;
        }
        for (let i = 0; i < nextOrder.length; i += 1) {
            if (nextOrder[i] !== lastRenderOrder[i]) {
                return false;
            }
        }
        return true;
    }

    function patchRender(container, items, renderer) {
        for (const account of items) {
            const selector = `[data-email="${escapeCss(account.email)}"]`;
            const existing = container.querySelector(selector);
            if (!existing) {
                return false;
            }
            const html = renderer(account);
            const parsed = new DOMParser().parseFromString(html, 'text/html');
            const replacement = parsed.body.firstElementChild;
            if (!replacement) {
                return false;
            }
            existing.replaceWith(replacement);
        }
        return true;
    }

    function render() {
        renderToken += 1;
        updateSortOptions();
        updateFilterOptions();

        if (elements.currentAccount) {
            const current = accounts.find(acc => acc.isCurrent);
            if (current) {
                elements.currentAccount.textContent = `${getString('current', 'Current')} ${current.email}`;
                elements.currentAccount.title = current.email;
                elements.currentAccount.classList.remove('hidden');
            } else {
                elements.currentAccount.classList.add('hidden');
            }
        }

        if (elements.totalAccounts) {
            elements.totalAccounts.textContent = (getString('totalAccounts', '{count} Accounts')).replace('{count}', accounts.length);
        }

        if (isInitialLoading) {
            elements.loading.classList.remove('hidden');
            elements.emptyState.classList.add('hidden');
            elements.emptyMatch.classList.add('hidden');
            elements.accountsGrid.classList.add('hidden');
            elements.accountsTable.classList.add('hidden');
            return;
        }

        const filteredAccounts = filterAndSortAccounts();

        elements.loading.classList.add('hidden');
        elements.emptyState.classList.add('hidden');
        elements.emptyMatch.classList.add('hidden');

        if (accounts.length === 0) {
            elements.emptyState.classList.remove('hidden');
            return;
        }

        if (filteredAccounts.length === 0) {
            elements.emptyMatch.classList.remove('hidden');
            return;
        }

        const nextRenderOrder = getRenderOrder(filteredAccounts);
        const canPatch = viewMode === lastRenderViewMode && isSameRenderOrder(nextRenderOrder);

        const finalizeRender = () => {
            const filteredEmails = filteredAccounts.map(acc => acc.email);
            const allSelected = filteredEmails.length > 0 && filteredEmails.every(email => selected.has(email));
            if (elements.selectAll) {
                elements.selectAll.checked = allSelected;
            }

            if (elements.deleteSelectedBtn) {
                if (selected.size > 0) {
                    elements.deleteSelectedBtn.classList.remove('hidden');
                    elements.deleteSelectedBtn.title = `${getString('delete', 'Delete')} (${selected.size})`;
                    elements.deleteSelectedBtn.setAttribute('aria-label', `${getString('delete', 'Delete')} (${selected.size})`);
                } else {
                    elements.deleteSelectedBtn.classList.add('hidden');
                }
            }

            if (elements.exportBtn) {
                const title = selected.size > 0
                    ? `${getString('export', 'Export')} (${selected.size})`
                    : getString('export', 'Export');
                elements.exportBtn.title = title;
                elements.exportBtn.setAttribute('aria-label', title);
            }
        };

        if (canPatch) {
            const target = viewMode === 'list' ? elements.accountsTbody : elements.accountsGrid;
            if (patchRender(target, filteredAccounts, viewMode === 'list' ? renderAccountRow : renderAccountCard)) {
                finalizeRender();
                return;
            }
        }

        elements.accountsGrid.classList.add('hidden');
        elements.accountsTable.classList.add('hidden');

        const renderIncrementally = (container, items, renderer) => {
            const token = renderToken;
            let index = 0;
            container.innerHTML = '';

            const step = () => {
                if (token !== renderToken) return;
                let html = '';
                let count = 0;
                while (index < items.length && count < RENDER_BATCH_SIZE) {
                    html += renderer(items[index]);
                    index += 1;
                    count += 1;
                }
                if (html) {
                    container.insertAdjacentHTML('beforeend', html);
                }
                if (index < items.length) {
                    requestAnimationFrame(step);
                } else {
                    finalizeRender();
                }
            };

            requestAnimationFrame(step);
        };

        if (viewMode === 'list') {
            elements.accountsTable.classList.remove('hidden');
            renderIncrementally(elements.accountsTbody, filteredAccounts, renderAccountRow);
        } else {
            elements.accountsGrid.classList.remove('hidden');
            renderIncrementally(elements.accountsGrid, filteredAccounts, renderAccountCard);
        }

        lastRenderOrder = nextRenderOrder;
        lastRenderViewMode = viewMode;

        return;
    }

    // =====================================================================
    // Modal Helpers
    // =====================================================================

    function setAddFeedback(status, message) {
        addStatus = status;
        addMessage = message || '';
        if (!elements.addFeedback) return;
        if (!addMessage) {
            elements.addFeedback.classList.add('hidden');
            return;
        }
        elements.addFeedback.className = `add-feedback ${addStatus}`;
        elements.addFeedback.textContent = addMessage;
        elements.addFeedback.classList.remove('hidden');
    }

    function resetAddModalState() {
        addStatus = 'idle';
        addMessage = '';
        setAddFeedback('idle', '');
        _oauthUrlCopied = false;
    }

    function openAddModal(tab) {
        if (!elements.addModal) return;
        elements.addModal.classList.remove('hidden');
        const nextTab = tab || 'oauth';
        setAddTab(nextTab);
        resetAddModalState();
        if (nextTab === 'oauth') {
            requestOauthUrl();
        }
    }

    function closeAddModal() {
        if (!elements.addModal) return;
        elements.addModal.classList.add('hidden');
        resetAddModalState();
        cancelOauthSession();
    }

    function setAddTab(tab) {
        elements.addTabs.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        elements.addPanels.forEach(panel => {
            panel.classList.toggle('hidden', panel.dataset.panel !== tab);
        });
        if (tab === 'oauth') {
            requestOauthUrl();
        } else {
            cancelOauthSession();
        }
    }

    function setOauthUrl(url) {
        oauthUrl = url || '';
        oauthPreparing = false;
        if (elements.oauthLink) {
            elements.oauthLink.value = oauthUrl || getString('oauthGenerating', 'Generating link...');
        }
        if (elements.oauthCopy) {
            elements.oauthCopy.disabled = !oauthUrl;
        }
        if (elements.oauthContinue) {
            elements.oauthContinue.disabled = !oauthUrl;
        }
    }

    function requestOauthUrl() {
        if (oauthPreparing || oauthUrl) return;
        oauthPreparing = true;
        vscode.postMessage({ command: 'addAccount', mode: 'prepare' });
    }

    function cancelOauthSession() {
        if (oauthUrl || oauthPreparing) {
            vscode.postMessage({ command: 'addAccount', mode: 'cancel' });
        }
        oauthPreparing = false;
        setOauthUrl('');
    }

    function showConfirmModal(title, message, onConfirm) {
        if (!elements.confirmModal) return;
        elements.confirmTitle.textContent = title;
        elements.confirmMessage.textContent = message;
        confirmCallback = onConfirm;
        elements.confirmModal.classList.remove('hidden');
    }

    function hideConfirmModal() {
        if (!elements.confirmModal) return;
        elements.confirmModal.classList.add('hidden');
        confirmCallback = null;
    }

    function openQuotaModal(email) {
        currentQuotaEmail = email;
        if (!elements.quotaModal) return;
        renderQuotaDetails(email);
        elements.quotaModal.classList.remove('hidden');
    }

    function closeQuotaModal() {
        if (!elements.quotaModal) return;
        elements.quotaModal.classList.add('hidden');
        currentQuotaEmail = null;
    }

    function renderQuotaDetails(email) {
        const account = accounts.find(acc => acc.email === email);
        if (!account || !elements.quotaList) return;

        if (elements.quotaBadges) {
            const tier = getTierLabel(account);
            const tierClass = sanitizeClassName(getTierClass(tier));
            elements.quotaBadges.innerHTML = tier ? `<span class="pill ${tierClass}">${escapeHtml(tier)}</span>` : '';
        }

        if (account.loading) {
            elements.quotaList.innerHTML = `<div class="quota-empty">${escapeHtml(getString('loading', 'Loading...'))}</div>`;
            return;
        }

        if (account.error) {
            elements.quotaList.innerHTML = `<div class="quota-empty quota-error">⚠️ ${escapeHtml(account.error)}</div>`;
            return;
        }

        const models = [];
        (account.groups || []).forEach(group => {
            (group.models || []).forEach(model => {
                models.push({
                    label: model.label || group.groupName,
                    percentage: model.percentage || 0,
                    resetTime: model.resetTimeFormatted || model.resetTime || '',
                });
            });
        });

        if (models.length === 0) {
            elements.quotaList.innerHTML = `<div class="quota-empty">${escapeHtml(getString('noQuotaData', 'No quota data'))}</div>`;
            return;
        }

        elements.quotaList.innerHTML = models.map(model => {
            const pct = Math.round(model.percentage || 0);
            const pctClass = getQuotaClass(pct);
            return `
                <div class="quota-card">
                    <h4>${escapeHtml(model.label)}</h4>
                    <div class="quota-value-row">
                        <span class="quota-value ${pctClass}">${pct}%</span>
                    </div>
                    <div class="quota-bar">
                        <div class="quota-fill ${pctClass}" style="width: ${Math.min(100, pct)}%"></div>
                    </div>
                    ${model.resetTime ? `<div class="quota-reset-info">${escapeHtml(model.resetTime)}</div>` : ''}
                </div>
            `;
        }).join('');
    }

    // =====================================================================
    // Event Bindings
    // =====================================================================

    function bindEvents() {
        elements.backBtn?.addEventListener('click', () => {
            vscode.postMessage({ command: 'back' });
        });

        elements.searchInput?.addEventListener('input', (e) => {
            searchQuery = e.target.value;
            render();
        });

        elements.filterSelect?.addEventListener('change', (e) => {
            filterType = e.target.value;
            render();
        });

        elements.sortSelect?.addEventListener('change', (e) => {
            sortBy = e.target.value;
            render();
        });

        elements.sortDirectionBtn?.addEventListener('click', () => {
            sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            render();
        });

        elements.viewListBtn?.addEventListener('click', () => setViewMode('list'));
        elements.viewGridBtn?.addEventListener('click', () => setViewMode('grid'));

        elements.refreshAllBtn?.addEventListener('click', () => {
            if (elements.refreshAllBtn.disabled) return;
            startRefreshCooldown(REFRESH_COOLDOWN_SECONDS);
            vscode.postMessage({ command: 'executeCommand', commandId: 'agCockpit.accountTree.refresh' });
        });

        elements.addBtn?.addEventListener('click', () => openAddModal('oauth'));
        elements.importBtn?.addEventListener('click', () => openAddModal('import'));
        elements.addFirstBtn?.addEventListener('click', () => openAddModal('oauth'));

        elements.exportBtn?.addEventListener('click', () => {
            const emails = selected.size > 0 ? Array.from(selected) : accounts.map(acc => acc.email);
            vscode.postMessage({ command: 'exportAccounts', emails });
        });

        elements.deleteSelectedBtn?.addEventListener('click', () => {
            if (selected.size === 0) return;
            const message = getString('confirmDeleteBatch', 'Confirm delete {count} selected accounts?').replace('{count}', selected.size);
            showConfirmModal(getString('delete', 'Delete'), message, () => {
                vscode.postMessage({ command: 'deleteAccounts', emails: Array.from(selected) });
                selected.clear();
                render();
            });
        });

        elements.selectAll?.addEventListener('change', (e) => {
            const checked = e.target.checked;
            const filtered = filterAndSortAccounts();
            if (checked) {
                filtered.forEach(acc => selected.add(acc.email));
            } else {
                filtered.forEach(acc => selected.delete(acc.email));
            }
            render();
        });

        elements.accountsGrid?.addEventListener('click', handleAccountAction);
        elements.accountsTbody?.addEventListener('click', handleAccountAction);

        elements.actionMessageClose?.addEventListener('click', hideActionMessage);

        // Add modal
        elements.addClose?.addEventListener('click', closeAddModal);
        elements.addModal?.addEventListener('click', (e) => {
            if (e.target === elements.addModal) closeAddModal();
        });

        elements.addTabs?.forEach(tab => {
            tab.addEventListener('click', () => {
                setAddTab(tab.dataset.tab);
                resetAddModalState();
            });
        });

        elements.oauthStart?.addEventListener('click', () => {
            setAddFeedback('loading', getString('oauthStarting', 'Authorizing...'));
            vscode.postMessage({ command: 'addAccount', mode: 'start' });
        });

        elements.oauthContinue?.addEventListener('click', () => {
            setAddFeedback('loading', getString('oauthContinuing', 'Waiting for authorization...'));
            vscode.postMessage({ command: 'addAccount', mode: 'continue' });
        });

        elements.oauthCopy?.addEventListener('click', async () => {
            if (!oauthUrl) return;
            try {
                await navigator.clipboard.writeText(oauthUrl);
                _oauthUrlCopied = true;
                showToast(getString('copySuccess', 'Copied'), 'success');
            } catch {
                showToast(getString('copyFailed', 'Copy failed'), 'error');
            }
        });

        elements.tokenImport?.addEventListener('click', () => {
            const content = elements.tokenInput?.value || '';
            setAddFeedback('loading', getString('tokenImportStart', 'Start Import'));
            vscode.postMessage({ command: 'importTokens', content });
        });

        elements.importLocal?.addEventListener('click', () => {
            setAddFeedback('loading', getString('importingLocal', 'Importing...'));
            vscode.postMessage({ command: 'importFromLocal' });
        });

        elements.importTools?.addEventListener('click', () => {
            setAddFeedback('loading', getString('importingTools', 'Importing...'));
            vscode.postMessage({ command: 'importFromTools' });
        });

        // Confirm modal
        elements.confirmCancel?.addEventListener('click', hideConfirmModal);
        elements.confirmClose?.addEventListener('click', hideConfirmModal);
        elements.confirmModal?.addEventListener('click', (e) => {
            if (e.target === elements.confirmModal) hideConfirmModal();
        });
        elements.confirmOk?.addEventListener('click', () => {
            if (confirmCallback) confirmCallback();
            hideConfirmModal();
        });

        // Quota modal
        elements.quotaClose?.addEventListener('click', closeQuotaModal);
        elements.quotaCloseBtn?.addEventListener('click', closeQuotaModal);
        elements.quotaModal?.addEventListener('click', (e) => {
            if (e.target === elements.quotaModal) closeQuotaModal();
        });
        elements.quotaRefresh?.addEventListener('click', () => {
            if (!currentQuotaEmail) return;
            vscode.postMessage({ command: 'refreshAccount', email: currentQuotaEmail });
        });

        // Settings modal
        document.getElementById('settings-btn')?.addEventListener('click', openSettingsModal);
        document.getElementById('close-settings-btn')?.addEventListener('click', closeSettingsModal);

        // Announcements
        document.getElementById('announcement-btn')?.addEventListener('click', openAnnouncementList);
        document.getElementById('announcement-list-close')?.addEventListener('click', closeAnnouncementList);
        document.getElementById('announcement-mark-all-read')?.addEventListener('click', markAllAnnouncementsRead);
        document.getElementById('announcement-popup-later')?.addEventListener('click', closeAnnouncementPopup);
        document.getElementById('announcement-popup-got-it')?.addEventListener('click', handleAnnouncementGotIt);
        document.getElementById('announcement-popup-action')?.addEventListener('click', handleAnnouncementAction);
    }

    function handleAccountAction(event) {
        const target = event.target.closest('[data-action]');
        if (!target) return;

        const action = target.dataset.action;
        const email = target.dataset.email;

        switch (action) {
        case 'select':
            if (target.checked) {
                selected.add(email);
            } else {
                selected.delete(email);
            }
            render();
            break;
        case 'details':
            openQuotaModal(email);
            break;
        case 'switch':
            vscode.postMessage({ command: 'switchAccount', email });
            break;
        case 'refresh':
            vscode.postMessage({ command: 'refreshAccount', email });
            break;
        case 'export':
            vscode.postMessage({ command: 'exportAccounts', emails: [email] });
            break;
        case 'delete':
            showConfirmModal(getString('delete', 'Delete'), getString('confirmDelete', 'Confirm delete account?'), () => {
                vscode.postMessage({ command: 'deleteAccount', email });
                selected.delete(email);
            });
            break;
        default:
            break;
        }
    }

    // =====================================================================
    // Announcement (copied from dashboard.js)
    // =====================================================================

    let announcementState = {
        announcements: [],
        unreadIds: [],
        popupAnnouncement: null,
    };
    let currentPopupAnnouncement = null;
    let shownPopupIds = new Set();

    function updateAnnouncementBadge() {
        const badge = document.getElementById('announcement-badge');
        if (!badge) return;
        const count = announcementState.unreadIds.length;
        if (count > 0) {
            badge.textContent = count > 9 ? '9+' : count;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    function openAnnouncementList() {
        vscode.postMessage({ command: 'announcement.getState' });
        const modal = document.getElementById('announcement-list-modal');
        if (modal) modal.classList.remove('hidden');
    }

    function closeAnnouncementList() {
        const modal = document.getElementById('announcement-list-modal');
        if (modal) modal.classList.add('hidden');
    }

    function renderAnnouncementList() {
        const container = document.getElementById('announcement-list');
        if (!container) return;

        const announcements = announcementState.announcements || [];
        container.textContent = '';
        if (announcements.length === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'announcement-empty';
            emptyEl.textContent = getI18n('announcement.empty', 'No notifications');
            container.appendChild(emptyEl);
            return;
        }

        const typeIcons = { feature: '✨', warning: '⚠️', info: 'ℹ️', urgent: '🚨' };

        announcements.forEach(ann => {
            const isUnread = announcementState.unreadIds.includes(ann.id);
            const icon = typeIcons[ann.type] || 'ℹ️';
            const timeAgo = formatTimeAgo(ann.createdAt);

            const item = document.createElement('div');
            item.className = `announcement-item ${isUnread ? 'unread' : ''}`;
            item.dataset.id = String(ann.id ?? '');

            const iconEl = document.createElement('span');
            iconEl.className = 'announcement-icon';
            iconEl.textContent = icon;

            const info = document.createElement('div');
            info.className = 'announcement-info';

            const title = document.createElement('div');
            title.className = 'announcement-title';
            if (isUnread) {
                const dot = document.createElement('span');
                dot.className = 'announcement-unread-dot';
                title.appendChild(dot);
            }
            const titleText = document.createElement('span');
            titleText.textContent = ann.title || '';
            title.appendChild(titleText);

            const summary = document.createElement('div');
            summary.className = 'announcement-summary';
            summary.textContent = ann.summary || '';

            const time = document.createElement('div');
            time.className = 'announcement-time';
            time.textContent = timeAgo;

            info.append(title, summary, time);
            item.append(iconEl, info);
            container.appendChild(item);
        });

        container.querySelectorAll('.announcement-item').forEach(item => {
            item.addEventListener('click', () => {
                const id = item.dataset.id;
                const ann = announcements.find(a => a.id === id);
                if (ann) {
                    if (announcementState.unreadIds.includes(id)) {
                        vscode.postMessage({ command: 'announcement.markAsRead', id });
                        announcementState.unreadIds = announcementState.unreadIds.filter(uid => uid !== id);
                        updateAnnouncementBadge();
                        item.classList.remove('unread');
                        const dot = item.querySelector('.announcement-unread-dot');
                        if (dot) dot.remove();
                    }
                    showAnnouncementPopup(ann, true);
                    closeAnnouncementList();
                }
            });
        });
    }

    function formatTimeAgo(dateStr) {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return getI18n('announcement.timeAgo.justNow', 'Just now');
        if (diffMins < 60) return (getI18n('announcement.timeAgo.minutesAgo', '{count}m ago')).replace('{count}', diffMins);
        if (diffHours < 24) return (getI18n('announcement.timeAgo.hoursAgo', '{count}h ago')).replace('{count}', diffHours);
        return (getI18n('announcement.timeAgo.daysAgo', '{count}d ago')).replace('{count}', diffDays);
    }

    function showAnnouncementPopup(ann, fromList = false) {
        currentPopupAnnouncement = ann;

        const typeLabels = {
            feature: getI18n('announcement.type.feature', '✨ New Feature'),
            warning: getI18n('announcement.type.warning', '⚠️ Warning'),
            info: getI18n('announcement.type.info', 'ℹ️ Info'),
            urgent: getI18n('announcement.type.urgent', '🚨 Urgent'),
        };

        const popupType = document.getElementById('announcement-popup-type');
        const popupTitle = document.getElementById('announcement-popup-title');
        const popupContent = document.getElementById('announcement-popup-content');
        const popupAction = document.getElementById('announcement-popup-action');
        const popupGotIt = document.getElementById('announcement-popup-got-it');
        const backBtn = document.getElementById('announcement-popup-back');
        const closeBtn = document.getElementById('announcement-popup-close');

        if (popupType) {
            popupType.textContent = typeLabels[ann.type] || typeLabels.info;
            popupType.className = `announcement-type-badge ${ann.type}`;
        }
        if (popupTitle) popupTitle.textContent = ann.title;

        if (popupContent) {
            popupContent.textContent = '';

            const textBlock = document.createElement('div');
            textBlock.className = 'announcement-text';
            appendTextWithLineBreaks(textBlock, ann.content || '');
            popupContent.appendChild(textBlock);

            if (ann.images && ann.images.length > 0) {
                const imagesWrap = document.createElement('div');
                imagesWrap.className = 'announcement-images';
                for (const img of ann.images) {
                    const item = document.createElement('div');
                    item.className = 'announcement-image-item';

                    const imgEl = document.createElement('img');
                    imgEl.className = 'announcement-image';
                    const safeImgUrl = sanitizeUrl(img.url);
                    if (safeImgUrl) {
                        imgEl.src = safeImgUrl;
                        imgEl.dataset.previewUrl = safeImgUrl;
                    }
                    imgEl.alt = img.alt || img.label || '';
                    imgEl.title = getI18n('announcement.clickToEnlarge', 'Click to enlarge');

                    const skeleton = document.createElement('div');
                    skeleton.className = 'image-skeleton';

                    item.append(imgEl, skeleton);

                    if (img.label) {
                        const label = document.createElement('div');
                        label.className = 'announcement-image-label';
                        label.textContent = img.label;
                        item.appendChild(label);
                    }

                    imagesWrap.appendChild(item);
                }
                popupContent.appendChild(imagesWrap);

                popupContent.querySelectorAll('.announcement-image').forEach(imgEl => {
                    imgEl.addEventListener('load', () => {
                        imgEl.classList.add('loaded');
                    });

                    imgEl.addEventListener('error', () => {
                        const item = imgEl.closest('.announcement-image-item');
                        if (item) {
                            const skeleton = item.querySelector('.image-skeleton');
                            if (skeleton) skeleton.remove();
                            imgEl.style.display = 'none';
                            const errorDiv = document.createElement('div');
                            errorDiv.className = 'image-load-error';
                            const icon = document.createElement('span');
                            icon.className = 'icon';
                            icon.textContent = '🖼️';
                            const text = document.createElement('span');
                            text.textContent = getI18n('announcement.imageLoadFailed', 'Image failed to load');
                            errorDiv.append(icon, text);
                            item.insertBefore(errorDiv, item.firstChild);
                        }
                    });

                    imgEl.addEventListener('click', () => {
                        const url = imgEl.getAttribute('data-preview-url');
                        if (url) showImagePreview(url);
                    });
                });
            }
        }

        if (ann.action && ann.action.label) {
            if (popupAction) {
                popupAction.textContent = ann.action.label;
                popupAction.classList.remove('hidden');
            }
            if (popupGotIt) popupGotIt.classList.add('hidden');
        } else {
            if (popupAction) popupAction.classList.add('hidden');
            if (popupGotIt) popupGotIt.classList.remove('hidden');
        }

        if (fromList) {
            if (backBtn) {
                backBtn.classList.remove('hidden');
                backBtn.onclick = () => {
                    closeAnnouncementPopup(true);
                    openAnnouncementList();
                };
            }
            if (closeBtn) {
                closeBtn.onclick = () => closeAnnouncementPopup(true);
            }
        } else {
            if (backBtn) backBtn.classList.add('hidden');
            if (closeBtn) {
                closeBtn.onclick = () => closeAnnouncementPopup();
            }
        }

        const modal = document.getElementById('announcement-popup-modal');
        if (modal) modal.classList.remove('hidden');
    }

    function markCurrentAnnouncementAsRead() {
        if (!currentPopupAnnouncement) return;
        const id = currentPopupAnnouncement.id;
        vscode.postMessage({ command: 'announcement.markAsRead', id });
        if (announcementState.unreadIds.includes(id)) {
            announcementState.unreadIds = announcementState.unreadIds.filter(uid => uid !== id);
            updateAnnouncementBadge();
        }
    }

    function closeAnnouncementPopup(skipAnimation = false) {
        markCurrentAnnouncementAsRead();
        const modal = document.getElementById('announcement-popup-modal');
        const modalContent = modal?.querySelector('.announcement-popup-content');
        const bellBtn = document.getElementById('announcement-btn');

        if (modal && modalContent && bellBtn && !skipAnimation) {
            const bellRect = bellBtn.getBoundingClientRect();
            const contentRect = modalContent.getBoundingClientRect();
            const targetX = bellRect.left + bellRect.width / 2 - (contentRect.left + contentRect.width / 2);
            const targetY = bellRect.top + bellRect.height / 2 - (contentRect.top + contentRect.height / 2);

            modalContent.style.transition = 'transform 0.4s ease-in, opacity 0.4s ease-in';
            modalContent.style.transform = `translate(${targetX}px, ${targetY}px) scale(0.1)`;
            modalContent.style.opacity = '0';

            bellBtn.classList.add('bell-shake');

            setTimeout(() => {
                modal.classList.add('hidden');
                modalContent.style.transition = '';
                modalContent.style.transform = '';
                modalContent.style.opacity = '';
                bellBtn.classList.remove('bell-shake');
            }, 400);
        } else if (modal) {
            modal.classList.add('hidden');
        }

        currentPopupAnnouncement = null;
    }

    function handleAnnouncementGotIt() {
        closeAnnouncementPopup();
    }

    function handleAnnouncementAction() {
        if (currentPopupAnnouncement && currentPopupAnnouncement.action) {
            const action = currentPopupAnnouncement.action;

            if (action.type === 'tab') {
                vscode.postMessage({ command: 'openDashboard', tab: action.target });
            } else if (action.type === 'url') {
                vscode.postMessage({ command: 'openUrl', url: action.target });
            } else if (action.type === 'command') {
                vscode.postMessage({ command: 'executeCommand', commandId: action.target, commandArgs: action.arguments || [] });
            }
        }
        closeAnnouncementPopup();
    }

    function markAllAnnouncementsRead() {
        vscode.postMessage({ command: 'announcement.markAllAsRead' });
        showToast(getI18n('announcement.markAllRead', 'All marked as read'), 'success');
    }

    function handleAnnouncementState(state) {
        announcementState = state;
        updateAnnouncementBadge();
        renderAnnouncementList();

        if (state.popupAnnouncement && !shownPopupIds.has(state.popupAnnouncement.id)) {
            shownPopupIds.add(state.popupAnnouncement.id);
            setTimeout(() => {
                showAnnouncementPopup(state.popupAnnouncement);
            }, 600);
        }
    }

    function showImagePreview(imageUrl) {
        const safeUrl = sanitizeUrl(imageUrl);
        if (!safeUrl) return;
        const overlay = document.createElement('div');
        overlay.className = 'image-preview-overlay';
        const previewContainer = document.createElement('div');
        previewContainer.className = 'image-preview-container';
        const img = document.createElement('img');
        img.className = 'image-preview-img';
        img.src = safeUrl;
        const hint = document.createElement('div');
        hint.className = 'image-preview-hint';
        hint.textContent = getI18n('announcement.clickToClose', 'Click to close');
        previewContainer.append(img, hint);
        overlay.appendChild(previewContainer);

        overlay.addEventListener('click', () => {
            overlay.classList.add('closing');
            setTimeout(() => overlay.remove(), 200);
        });

        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('visible'));
    }

    window.showImagePreview = showImagePreview;

    // =====================================================================
    // Settings (from dashboard.js)
    // =====================================================================

    function openSettingsModal() {
        const modal = document.getElementById('settings-modal');
        if (!modal) return;

        const notificationCheckbox = document.getElementById('notification-enabled');
        const warningInput = document.getElementById('warning-threshold');
        const criticalInput = document.getElementById('critical-threshold');
        if (notificationCheckbox) notificationCheckbox.checked = currentConfig.notificationEnabled !== false;
        if (warningInput) warningInput.value = currentConfig.warningThreshold || 30;
        if (criticalInput) criticalInput.value = currentConfig.criticalThreshold || 10;

        const displayModeSelect = document.getElementById('display-mode-select');
        if (displayModeSelect) {
            const currentDisplayMode = currentConfig.displayMode || 'webview';
            displayModeSelect.value = currentDisplayMode;
            displayModeSelect.onchange = () => {
                const newMode = displayModeSelect.value;
                if (newMode === 'quickpick') {
                    vscode.postMessage({ command: 'updateDisplayMode', displayMode: 'quickpick' });
                }
            };
        }

        initLanguageSelector();
        initStatusBarFormatSelector();
        initSettingsAutoSave();

        modal.classList.remove('hidden');
    }

    function closeSettingsModal() {
        const modal = document.getElementById('settings-modal');
        if (modal) modal.classList.add('hidden');
    }

    function initStatusBarFormatSelector() {
        const formatSelect = document.getElementById('statusbar-format');
        if (!formatSelect) return;

        const currentFormat = currentConfig.statusBarFormat || 'standard';
        formatSelect.value = currentFormat;

        formatSelect.onchange = null;
        formatSelect.addEventListener('change', () => {
            const format = formatSelect.value;
            vscode.postMessage({ command: 'updateStatusBarFormat', statusBarFormat: format });
        });
    }

    function initLanguageSelector() {
        const languageSelect = document.getElementById('language-select');
        if (!languageSelect) return;

        const currentLanguage = currentConfig.language || 'auto';
        languageSelect.value = currentLanguage;

        languageSelect.onchange = null;
        languageSelect.addEventListener('change', () => {
            const newLanguage = languageSelect.value;
            vscode.postMessage({ command: 'updateLanguage', language: newLanguage });
            showToast(getI18n('language.changed', 'Language changed. Reopen panel to apply.'), 'info');
        });
    }

    function initSettingsAutoSave() {
        const notificationCheckbox = document.getElementById('notification-enabled');
        const warningInput = document.getElementById('warning-threshold');
        const criticalInput = document.getElementById('critical-threshold');

        if (notificationCheckbox) {
            notificationCheckbox.onchange = null;
            notificationCheckbox.addEventListener('change', () => {
                vscode.postMessage({
                    command: 'updateNotificationEnabled',
                    notificationEnabled: notificationCheckbox.checked
                });
            });
        }

        if (warningInput) {
            warningInput.onblur = null;
            warningInput.addEventListener('blur', clampAndSaveThresholds);
        }

        if (criticalInput) {
            criticalInput.onblur = null;
            criticalInput.addEventListener('blur', clampAndSaveThresholds);
        }
    }

    function clampAndSaveThresholds() {
        const warningInput = document.getElementById('warning-threshold');
        const criticalInput = document.getElementById('critical-threshold');

        let warningValue = parseInt(warningInput?.value, 10) || 30;
        let criticalValue = parseInt(criticalInput?.value, 10) || 10;

        if (warningValue < 5) warningValue = 5;
        if (warningValue > 80) warningValue = 80;
        if (criticalValue < 1) criticalValue = 1;
        if (criticalValue > 50) criticalValue = 50;

        if (criticalValue >= warningValue) {
            criticalValue = warningValue - 1;
            if (criticalValue < 1) criticalValue = 1;
        }

        if (warningInput) warningInput.value = warningValue;
        if (criticalInput) criticalInput.value = criticalValue;

        saveThresholds();
    }

    function saveThresholds() {
        const notificationCheckbox = document.getElementById('notification-enabled');
        const warningInput = document.getElementById('warning-threshold');
        const criticalInput = document.getElementById('critical-threshold');

        const notificationEnabled = notificationCheckbox?.checked ?? true;
        const warningValue = parseInt(warningInput?.value, 10) || 30;
        const criticalValue = parseInt(criticalInput?.value, 10) || 10;

        vscode.postMessage({
            command: 'updateThresholds',
            notificationEnabled: notificationEnabled,
            warningThreshold: warningValue,
            criticalThreshold: criticalValue
        });
    }

    // =====================================================================
    // Toast
    // =====================================================================

    function showToast(message, type = 'info') {
        if (!elements.toast) return;
        elements.toast.textContent = message;
        elements.toast.className = `toast ${type}`;
        setTimeout(() => {
            elements.toast.classList.add('hidden');
        }, 3000);
    }

    // =====================================================================
    // Message Handling
    // =====================================================================

    function handleMessage(event) {
        const message = event.data;
        switch (message.type) {
        case 'accountsUpdate':
            accounts = message.data.accounts || [];
            if (message.data.i18n) {
                Object.assign(strings, message.data.i18n);
            }
            if (message.data.config) {
                currentConfig = message.data.config;
            }
            refreshAllLabel = getString('refreshAll', 'Refresh');
            if (elements.refreshAllBtn && !elements.refreshAllBtn.disabled) {
                elements.refreshAllBtn.textContent = refreshAllLabel;
            }
            if (isInitialLoading) {
                isInitialLoading = false;
            }
            selected = new Set(Array.from(selected).filter(email => accounts.some(acc => acc.email === email)));
            render();
            break;
        case 'announcementState':
            handleAnnouncementState(message.data);
            break;
        case 'actionResult':
            handleActionResult(message.data);
            break;
        case 'actionProgress':
            handleActionProgress(message.data);
            break;
        case 'oauthUrl':
            setOauthUrl(message.data.url || '');
            break;
        default:
            break;
        }
    }

    function handleActionResult(data) {
        const status = data.status || 'success';
        const message = data.message || '';
        const context = data.context || '';

        if (context === 'add') {
            oauthPreparing = false;
            setAddFeedback(status, message);
            if (status === 'success' && data.closeModal) {
                setTimeout(() => closeAddModal(), 1200);
            }
            return;
        }

        if (message) {
            showActionMessage(message, status === 'error' ? 'error' : 'success');
        }
    }

    function handleActionProgress(data) {
        const message = data.message || '';
        if (data.context === 'add') {
            setAddFeedback('loading', message);
        }
    }

    // =====================================================================
    // Initialization
    // =====================================================================

    function init() {
        const state = vscode.getState();
        if (state?.viewMode) {
            viewMode = state.viewMode;
        }
        refreshAllLabel = getString('refreshAll', 'Refresh');
        setViewMode(viewMode);
        setOauthUrl(oauthUrl);
        bindEvents();
        window.addEventListener('message', handleMessage);
        vscode.postMessage({ command: 'ready' });
    }

    init();
})();
