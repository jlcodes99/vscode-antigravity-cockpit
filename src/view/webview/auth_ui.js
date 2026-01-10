/**
 * Antigravity Cockpit - Shared Authentication UI
 * 用于统一 Dashboard 和 Auto Trigger 两个视图的账号授权和同步配置 UI
 */

(function () {
    'use strict';

    // 国际化辅助
    const i18n = window.__i18n || {};
    const t = (key) => i18n[key] || key;

    class AuthenticationUI {
        constructor(vscodeApi) {
            this.vscode = vscodeApi;
            this.state = {
                authorization: null,
                antigravityToolsSyncEnabled: false
            };
            this.elements = {};
        }

        updateState(authorization, antigravityToolsSyncEnabled) {
            this.state.authorization = authorization;
            if (antigravityToolsSyncEnabled !== undefined) {
                this.state.antigravityToolsSyncEnabled = antigravityToolsSyncEnabled;
            }
        }

        /**
         * 渲染授权行 (Auth Row)
         * @param {HTMLElement} container 容器元素
         * @param {Object} options 配置项
         * @param {boolean} options.showSyncToggleInline 是否内联显示同步开关（否则显示配置按钮）
         */
        renderAuthRow(container, options = {}) {
            if (!container) return;

            const { authorization, antigravityToolsSyncEnabled } = this.state;
            const accounts = authorization?.accounts || [];
            const hasAccounts = accounts.length > 0;
            const activeAccount = authorization?.activeAccount;
            const activeEmail = activeAccount || (hasAccounts ? accounts[0].email : null);
            const isAuthorized = authorization?.isAuthorized || hasAccounts;

            // Common Buttons
            const manageBtn = `<button class="quota-account-manage-btn" title="${t('autoTrigger.manageAccounts')}">${t('autoTrigger.manageAccounts')}</button>`;

            // Sync UI Elements
            let syncActionsHtml = '';

            if (options.showSyncToggleInline) {
                // Inline Style (Like Auto Trigger Tab)
                syncActionsHtml = `
                    <label class="antigravityTools-sync-toggle">
                        <input type="checkbox" class="at-sync-checkbox" ${antigravityToolsSyncEnabled ? 'checked' : ''}>
                        <span>${t('autoTrigger.antigravityToolsSync')}</span>
                    </label>
                    <button class="at-btn at-btn-secondary at-import-btn">${t('autoTrigger.importFromAntigravityTools')}</button>
                `;
            } else {
                // Compact Style (Like Dashboard Tab)
                syncActionsHtml = `
                    <button class="at-btn at-btn-outline at-sync-config-btn" title="${t('atSyncConfig.title') || 'Antigravity Tools 同步配置'}">
                        ⚙ ${t('atSyncConfig.btnText') || 'Antigravity Tools 同步配置'}
                    </button>
                `;
            }

            if (isAuthorized && activeEmail) {
                const extraCount = Math.max(accounts.length - 1, 0);
                const accountCountBadge = extraCount > 0
                    ? `<span class="account-count-badge" title="${t('autoTrigger.manageAccounts')}">+${extraCount}</span>`
                    : '';

                container.innerHTML = `
                    <div class="quota-auth-info quota-auth-info-clickable" title="${t('autoTrigger.manageAccounts')}">
                        <span class="quota-auth-icon">✅</span>
                        <span class="quota-auth-text">${t('autoTrigger.authorized')}</span>
                        <span class="quota-auth-email">${activeEmail}</span>
                        ${accountCountBadge}
                        ${manageBtn}
                    </div>
                    <div class="quota-auth-actions">
                        ${syncActionsHtml}
                    </div>
                 `;
            } else {
                // Unauthorized
                container.innerHTML = `
                    <div class="quota-auth-info">
                        <span class="quota-auth-icon">⚠️</span>
                        <span class="quota-auth-text">${t('autoTrigger.unauthorized') || 'Unauthorized'}</span>
                    </div>
                    <div class="quota-auth-actions">
                        ${syncActionsHtml}
                        <button class="at-btn at-btn-primary at-authorize-btn">${t('autoTrigger.authorizeBtn') || 'Authorize'}</button>
                    </div>
                `;
            }

            this._bindEvents(container);
        }

        _bindEvents(container) {
            // Bind generic events
            const postMessage = (msg) => this.vscode.postMessage(msg);

            // Manage Accounts / Click Info
            container.querySelector('.quota-auth-info-clickable')?.addEventListener('click', () => {
                this.openAccountManageModal();
            });
            container.querySelector('.quota-account-manage-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openAccountManageModal();
            });

            // Authorize
            container.querySelector('.at-authorize-btn')?.addEventListener('click', () => {
                postMessage({ command: 'autoTrigger.authorize' });
            });

            // Sync Config (Compact Mode)
            container.querySelector('.at-sync-config-btn')?.addEventListener('click', () => {
                this.openSyncConfigModal();
            });

            // Inline Sync Toggle
            container.querySelector('.at-sync-checkbox')?.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                // Update local state immediately for UI consistency
                this.state.antigravityToolsSyncEnabled = enabled;
                postMessage({ command: 'antigravityToolsSync.toggle', enabled });
            });

            // Inline Import
            container.querySelector('.at-import-btn')?.addEventListener('click', () => {
                postMessage({ command: 'antigravityToolsSync.import' });
            });
        }

        // ============ Modals ============

        openAccountManageModal() {
            let modal = document.getElementById('account-manage-modal');
            if (!modal) {
                modal = this._createModal('account-manage-modal', `
                    <div class="modal-content account-manage-content">
                        <div class="modal-header">
                            <h3>${t('autoTrigger.manageAccounts') || 'Manage Accounts'}</h3>
                            <button class="close-btn" id="close-account-manage-modal">×</button>
                        </div>
                        <div class="modal-body" id="account-manage-body"></div>
                        <div class="modal-footer">
                            <button id="add-new-account-btn" class="at-btn at-btn-primary">➕ ${t('autoTrigger.addAccount') || 'Add Account'}</button>
                        </div>
                    </div>
                `);

                // Bind Modal specific static events (close, add)
                document.getElementById('close-account-manage-modal')?.addEventListener('click', () => modal.classList.add('hidden'));
                document.getElementById('add-new-account-btn')?.addEventListener('click', () => {
                    this.vscode.postMessage({ command: 'autoTrigger.addAccount' });
                });
            }

            this.renderAccountManageList();
            modal.classList.remove('hidden');
        }

        renderAccountManageList() {
            const body = document.getElementById('account-manage-body');
            if (!body) return;

            const accounts = this.state.authorization?.accounts || [];
            const activeAccount = this.state.authorization?.activeAccount;

            if (accounts.length === 0) {
                body.innerHTML = `<div class="account-manage-empty">${t('autoTrigger.noAccounts') || 'No accounts authorized'}</div>`;
                return;
            }

            body.innerHTML = `<div class="account-manage-list">${accounts.map(acc => {
                const isActive = acc.email === activeAccount;
                const isInvalid = acc.isInvalid === true;
                const icon = isInvalid ? '⚠️' : (isActive ? '✅' : '👤');
                const badges = [
                    isActive && !isInvalid ? `<span class="account-manage-badge">${t('autoTrigger.accountActive')}</span>` : '',
                    isInvalid ? `<span class="account-manage-badge expired">${t('autoTrigger.tokenExpired')}</span>` : ''
                ].join('');

                return `
                    <div class="account-manage-item ${isActive ? 'active' : ''} ${isInvalid ? 'expired' : ''}" data-email="${acc.email}">
                        <div class="account-manage-info">
                            <span class="account-manage-icon">${icon}</span>
                            <span class="account-manage-email">${acc.email}</span>
                            ${badges}
                        </div>
                        <div class="account-manage-actions">
                            <button class="at-btn at-btn-small at-btn-secondary account-reauth-btn" data-email="${acc.email}">${t('autoTrigger.reauthorizeBtn')}</button>
                            <button class="at-btn at-btn-small at-btn-danger account-remove-btn" data-email="${acc.email}">${t('autoTrigger.revokeBtn')}</button>
                        </div>
                    </div>
                `;
            }).join('')}</div>`;

            // Bind list items events
            body.querySelectorAll('.account-manage-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
                    if (item.classList.contains('active')) return;
                    const email = item.dataset.email;
                    if (email) {
                        this.vscode.postMessage({ command: 'autoTrigger.switchAccount', email });
                        document.getElementById('account-manage-modal')?.classList.add('hidden');
                    }
                });
            });

            body.querySelectorAll('.account-reauth-btn').forEach(btn =>
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.vscode.postMessage({ command: 'autoTrigger.reauthorizeAccount', email: btn.dataset.email });
                })
            );

            body.querySelectorAll('.account-remove-btn').forEach(btn =>
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (typeof window.openRevokeModalForEmail === 'function') {
                        window.openRevokeModalForEmail(btn.dataset.email);
                    } else {
                        this.vscode.postMessage({ command: 'autoTrigger.removeAccount', email: btn.dataset.email });
                    }
                })
            );
        }

        openSyncConfigModal() {
            let modal = document.getElementById('at-sync-config-modal');
            if (!modal) {
                modal = this._createModal('at-sync-config-modal', `
                    <div class="modal-content at-sync-config-content">
                        <div class="modal-header">
                            <h3>⚙ ${t('atSyncConfig.title') || 'Antigravity Tools 同步配置'}</h3>
                            <button class="close-btn" id="close-at-sync-config-modal">×</button>
                        </div>
                        <div class="modal-body at-sync-config-body">
                            <div class="at-sync-section at-sync-info-section">
                                <div class="at-sync-section-title">🛡️ ${t('atSyncConfig.dataAccessTitle') || '数据访问说明'}</div>
                                <div class="at-sync-description">${t('atSyncConfig.dataAccessDesc') || '本功能将读取您本地 Antigravity Tools 的账户信息，用于在本插件中调用 AI 模型。'}</div>
                                <div class="at-sync-path-info">
                                    <span class="at-sync-path-label">${t('atSyncConfig.readPath') || '读取路径'}:</span>
                                    <code class="at-sync-path">~/.antigravity_tools/</code>
                                </div>
                                <div class="at-sync-data-list">
                                    <span class="at-sync-data-label">${t('atSyncConfig.readData') || '读取内容'}:</span>
                                    <span class="at-sync-data-items">${t('atSyncConfig.readDataItems') || '账户邮箱、Refresh Token'}</span>
                                </div>
                            </div>
                            <div class="at-sync-section">
                                <div class="at-sync-section-title">🔄 ${t('atSyncConfig.autoSyncTitle') || '自动同步'}</div>
                                <div class="at-sync-toggle-row">
                                    <label class="at-sync-toggle-label">
                                        <input type="checkbox" id="at-sync-modal-checkbox">
                                        <span>${t('atSyncConfig.enableAutoSync') || '启用自动同步'}</span>
                                    </label>
                                </div>
                                <div class="at-sync-description">${t('atSyncConfig.autoSyncDesc') || '启用后，当您在 Antigravity Tools 中切换账号时或者添加账户时，本插件会自动同步账户并切换到对应账号。'}</div>
                            </div>
                            <div class="at-sync-section">
                                <div class="at-sync-section-title">📥 ${t('atSyncConfig.manualImportTitle') || '手动导入'}</div>
                                <div class="at-sync-description">${t('atSyncConfig.manualImportDesc') || '将 Antigravity Tools 当前正在使用的账号立即导入到本插件。仅执行一次。'}</div>
                                <button id="at-sync-modal-import-btn" class="at-btn at-btn-primary at-sync-import-btn">${t('atSyncConfig.importNow') || '立即导入账户'}</button>
                            </div>
                        </div>
                    </div>
                `);
                document.getElementById('close-at-sync-config-modal')?.addEventListener('click', () => modal.classList.add('hidden'));

                modal.querySelector('#at-sync-modal-checkbox')?.addEventListener('change', (e) => {
                    this.state.antigravityToolsSyncEnabled = e.target.checked;
                    this.vscode.postMessage({ command: 'antigravityToolsSync.toggle', enabled: e.target.checked });
                });
                modal.querySelector('#at-sync-modal-import-btn')?.addEventListener('click', () => {
                    this.vscode.postMessage({ command: 'antigravityToolsSync.import' });
                    modal.classList.add('hidden');
                });
            }

            const checkbox = modal.querySelector('#at-sync-modal-checkbox');
            if (checkbox) checkbox.checked = this.state.antigravityToolsSyncEnabled;

            modal.classList.remove('hidden');
        }

        _createModal(id, html) {
            const modal = document.createElement('div');
            modal.id = id;
            modal.className = 'modal hidden';
            modal.innerHTML = html;
            document.body.appendChild(modal);
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.classList.add('hidden');
            });
            return modal;
        }
    }

    // Export to window
    window.AntigravityAuthUI = AuthenticationUI;

})();
