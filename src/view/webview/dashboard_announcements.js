export function createAnnouncementModule({
    vscode,
    i18n,
    showToast,
    switchToTab,
    escapeHtml,
}) {
    // 公告状态
    let announcementState = {
        announcements: [],
        unreadIds: [],
        popupAnnouncement: null,
    };
    let currentPopupAnnouncement = null;
    let shownPopupIds = new Set();

    function initAnnouncementEvents() {
        const announcementBtn = document.getElementById('announcement-btn');
        if (announcementBtn) announcementBtn.addEventListener('click', openAnnouncementList);

        const announcementListClose = document.getElementById('announcement-list-close');
        if (announcementListClose) announcementListClose.addEventListener('click', closeAnnouncementList);

        const announcementMarkAllRead = document.getElementById('announcement-mark-all-read');
        if (announcementMarkAllRead) announcementMarkAllRead.addEventListener('click', markAllAnnouncementsRead);

        const announcementPopupLater = document.getElementById('announcement-popup-later');
        if (announcementPopupLater) announcementPopupLater.addEventListener('click', closeAnnouncementPopup);

        const announcementPopupGotIt = document.getElementById('announcement-popup-got-it');
        if (announcementPopupGotIt) announcementPopupGotIt.addEventListener('click', handleAnnouncementGotIt);

        const announcementPopupAction = document.getElementById('announcement-popup-action');
        if (announcementPopupAction) announcementPopupAction.addEventListener('click', handleAnnouncementAction);

        window.showImagePreview = showImagePreview;
    }

    function updateAnnouncementBadge() {
        const badge = document.getElementById('announcement-badge');
        if (badge) {
            const count = announcementState.unreadIds.length;
            if (count > 0) {
                badge.textContent = count > 9 ? '9+' : count;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
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
        if (announcements.length === 0) {
            container.innerHTML = `<div class="announcement-empty">${i18n['announcement.empty'] || 'No notifications'}</div>`;
            return;
        }

        const typeIcons = {
            feature: '✨',
            warning: '⚠️',
            info: 'ℹ️',
            urgent: '🚨',
        };

        container.innerHTML = announcements.map(ann => {
            const isUnread = announcementState.unreadIds.includes(ann.id);
            const icon = typeIcons[ann.type] || 'ℹ️';
            const timeAgo = formatTimeAgo(ann.createdAt);

            return `
                <div class="announcement-item ${isUnread ? 'unread' : ''}" data-id="${ann.id}">
                    <span class="announcement-icon">${icon}</span>
                    <div class="announcement-info">
                        <div class="announcement-title">
                            ${isUnread ? '<span class="announcement-unread-dot"></span>' : ''}
                            <span>${ann.title}</span>
                        </div>
                        <div class="announcement-summary">${ann.summary}</div>
                        <div class="announcement-time">${timeAgo}</div>
                    </div>
                </div>
            `;
        }).join('');

        // 绑定点击事件
        container.querySelectorAll('.announcement-item').forEach(item => {
            item.addEventListener('click', () => {
                const id = item.dataset.id;
                const ann = announcements.find(a => a.id === id);
                if (ann) {
                    // 若未读，点击即标记已读
                    if (announcementState.unreadIds.includes(id)) {
                        vscode.postMessage({
                            command: 'announcement.markAsRead',
                            id: id
                        });
                        // 乐观更新本地状态
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

        if (diffMins < 1) return i18n['announcement.timeAgo.justNow'] || 'Just now';
        if (diffMins < 60) return (i18n['announcement.timeAgo.minutesAgo'] || '{count}m ago').replace('{count}', diffMins);
        if (diffHours < 24) return (i18n['announcement.timeAgo.hoursAgo'] || '{count}h ago').replace('{count}', diffHours);
        return (i18n['announcement.timeAgo.daysAgo'] || '{count}d ago').replace('{count}', diffDays);
    }

    function showAnnouncementPopup(ann, fromList = false) {
        currentPopupAnnouncement = ann;

        const typeLabels = {
            feature: i18n['announcement.type.feature'] || '✨ New Feature',
            warning: i18n['announcement.type.warning'] || '⚠️ Warning',
            info: i18n['announcement.type.info'] || 'ℹ️ Info',
            urgent: i18n['announcement.type.urgent'] || '🚨 Urgent',
        };

        const popupType = document.getElementById('announcement-popup-type');
        const popupTitle = document.getElementById('announcement-popup-title');
        const popupContent = document.getElementById('announcement-popup-content');
        const popupAction = document.getElementById('announcement-popup-action');
        const popupGotIt = document.getElementById('announcement-popup-got-it');

        // Header buttons
        const backBtn = document.getElementById('announcement-popup-back');
        const closeBtn = document.getElementById('announcement-popup-close');

        if (popupType) {
            popupType.textContent = typeLabels[ann.type] || typeLabels.info;
            popupType.className = `announcement-type-badge ${ann.type}`;
        }
        if (popupTitle) popupTitle.textContent = ann.title;

        // 渲染内容和图片
        if (popupContent) {
            let contentHtml = `<div class="announcement-text">${escapeHtml(ann.content).replace(/\n/g, '<br>')}</div>`;

            // 如果有图片，渲染图片区域（带骨架屏占位符）
            if (ann.images && ann.images.length > 0) {
                contentHtml += '<div class="announcement-images">';
                for (const img of ann.images) {
                    contentHtml += `
                        <div class="announcement-image-item">
                            <img src="${escapeHtml(img.url)}" 
                                 alt="${escapeHtml(img.alt || img.label || '')}" 
                                 class="announcement-image"
                                 data-preview-url="${escapeHtml(img.url)}"
                                 title="${i18n['announcement.clickToEnlarge'] || 'Click to enlarge'}" />
                            <div class="image-skeleton"></div>
                            ${img.label ? `<div class="announcement-image-label">${escapeHtml(img.label)}</div>` : ''}
                        </div>
                    `;
                }
                contentHtml += '</div>';
            }

            popupContent.innerHTML = contentHtml;

            // 绑定图片加载事件
            popupContent.querySelectorAll('.announcement-image').forEach(imgEl => {
                // 图片加载完成
                imgEl.addEventListener('load', () => {
                    imgEl.classList.add('loaded');
                });

                // 图片加载失败
                imgEl.addEventListener('error', () => {
                    const item = imgEl.closest('.announcement-image-item');
                    if (item) {
                        const skeleton = item.querySelector('.image-skeleton');
                        if (skeleton) skeleton.remove();
                        imgEl.style.display = 'none';
                        const errorDiv = document.createElement('div');
                        errorDiv.className = 'image-load-error';
                        errorDiv.innerHTML = `
                            <span class="icon">🖼️</span>
                            <span>${i18n['announcement.imageLoadFailed'] || 'Image failed to load'}</span>
                        `;
                        item.insertBefore(errorDiv, item.firstChild);
                    }
                });

                // 点击放大
                imgEl.addEventListener('click', () => {
                    const url = imgEl.getAttribute('data-preview-url');
                    if (url) showImagePreview(url);
                });
            });
        }

        // 处理操作按钮
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

        // 处理返回/关闭按钮显示
        if (fromList) {
            if (backBtn) {
                backBtn.classList.remove('hidden');
                backBtn.onclick = () => {
                    closeAnnouncementPopup(true); // 跳过动画
                    openAnnouncementList(); // 返回列表
                };
            }
            // 从列表进入时，关闭也跳过动画
            if (closeBtn) {
                closeBtn.onclick = () => {
                    closeAnnouncementPopup(true);
                };
            }
        } else {
            if (backBtn) backBtn.classList.add('hidden');
            // 自动弹窗时，关闭使用动画
            if (closeBtn) {
                closeBtn.onclick = () => {
                    closeAnnouncementPopup();
                };
            }
        }

        const modal = document.getElementById('announcement-popup-modal');
        if (modal) modal.classList.remove('hidden');
    }

    function markCurrentAnnouncementAsRead() {
        if (!currentPopupAnnouncement) return;
        const id = currentPopupAnnouncement.id;
        vscode.postMessage({
            command: 'announcement.markAsRead',
            id: id
        });
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
            // 获取铃铛按钮的位置
            const bellRect = bellBtn.getBoundingClientRect();
            const contentRect = modalContent.getBoundingClientRect();

            // 计算目标位移
            const targetX = bellRect.left + bellRect.width / 2 - (contentRect.left + contentRect.width / 2);
            const targetY = bellRect.top + bellRect.height / 2 - (contentRect.top + contentRect.height / 2);

            // 添加飞向铃铛的动画
            modalContent.style.transition = 'transform 0.4s ease-in, opacity 0.4s ease-in';
            modalContent.style.transform = `translate(${targetX}px, ${targetY}px) scale(0.1)`;
            modalContent.style.opacity = '0';

            // 铃铛抖动效果
            bellBtn.classList.add('bell-shake');

            // 动画结束后隐藏模态框并重置样式
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

            // 执行操作
            if (action.type === 'tab') {
                switchToTab(action.target);
            } else if (action.type === 'url') {
                vscode.postMessage({ command: 'openUrl', url: action.target });
            } else if (action.type === 'command') {
                vscode.postMessage({
                    command: 'executeCommand',
                    commandId: action.target,
                    commandArgs: action.arguments || []
                });
            }
        }
        closeAnnouncementPopup();
    }

    function markAllAnnouncementsRead() {
        vscode.postMessage({ command: 'announcement.markAllAsRead' });
        showToast(i18n['announcement.markAllRead'] || 'All marked as read', 'success');
    }

    function handleAnnouncementState(state) {
        announcementState = state;
        updateAnnouncementBadge();
        renderAnnouncementList();

        // 检查是否需要弹出公告（只弹未弹过的）
        if (state.popupAnnouncement && !shownPopupIds.has(state.popupAnnouncement.id)) {
            shownPopupIds.add(state.popupAnnouncement.id);
            // 延迟弹出，等待页面渲染完成
            setTimeout(() => {
                showAnnouncementPopup(state.popupAnnouncement);
            }, 600);
        }
    }

    // ============ 图片预览 ============

    function showImagePreview(imageUrl) {
        // 创建预览遮罩
        const overlay = document.createElement('div');
        overlay.className = 'image-preview-overlay';
        overlay.innerHTML = `
            <div class="image-preview-container">
                <img src="${imageUrl}" class="image-preview-img" />
                <div class="image-preview-hint">${i18n['announcement.clickToClose'] || 'Click to close'}</div>
            </div>
        `;

        // 点击关闭
        overlay.addEventListener('click', () => {
            overlay.classList.add('closing');
            setTimeout(() => overlay.remove(), 200);
        });

        document.body.appendChild(overlay);

        // 触发动画
        requestAnimationFrame(() => overlay.classList.add('visible'));
    }

    return {
        initAnnouncementEvents,
        handleAnnouncementState,
    };
}
