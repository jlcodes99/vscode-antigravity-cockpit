export function createHistoryModule({
    vscode,
    i18n,
    dom,
    historyState,
    authorizationStatusGetter,
}) {
    const {
        historyAccountSelect,
        historyModelSelect,
        historyRangeButtons,
        historyCanvas,
        historyEmpty,
        historyMetricLabel,
        historySummary,
        historyTableBody,
        historyTableEmpty,
        historyPrevBtn,
        historyNextBtn,
        historyPageInfo,
    } = dom;

    function initHistoryTab() {
        if (historyAccountSelect) {
            historyAccountSelect.addEventListener('change', () => {
                historyState.selectedEmail = historyAccountSelect.value || null;
                historyState.page = 1;
                requestQuotaHistory();
            });
        }

        if (historyModelSelect) {
            historyModelSelect.addEventListener('change', () => {
                historyState.selectedModelId = historyModelSelect.value || null;
                historyState.page = 1;
                requestQuotaHistory();
            });
        }

        historyRangeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const range = normalizeHistoryRange(parseInt(btn.dataset.range || '', 10));
                if (historyState.rangeDays === range) {
                    return;
                }
                historyState.rangeDays = range;
                updateHistoryRangeButtons();
                historyState.page = 1;
                requestQuotaHistory();
            });
        });

        const historyClearBtn = document.getElementById('history-clear-btn');
        const historyClearModal = document.getElementById('history-clear-modal');
        const historyClearThisBtn = document.getElementById('history-clear-this-btn');
        const historyClearAllBtn = document.getElementById('history-clear-all-btn');
        const historyClearCancelBtn = document.getElementById('history-clear-cancel');
        const historyClearCloseBtn = document.getElementById('history-clear-close');

        if (historyClearBtn && historyClearModal) {
            historyClearBtn.addEventListener('click', () => {
                if (historyState.selectedEmail) {
                    const msgEl = document.getElementById('history-clear-message');
                    if (msgEl) {
                        msgEl.textContent = (i18n['history.clearConfirm'] || 'Are you sure you want to clear quota history for {email}?').replace('{email}', historyState.selectedEmail);
                    }
                    if (historyClearThisBtn) {
                        historyClearThisBtn.textContent = `🗑️ ${i18n['history.clearThis'] || 'Clear This Account'}`;
                    }
                    historyClearModal.classList.remove('hidden');
                }
            });
        }

        const closeHistoryClearModal = () => {
            if (historyClearModal) {
                historyClearModal.classList.add('hidden');
            }
        };

        if (historyClearCloseBtn) historyClearCloseBtn.addEventListener('click', closeHistoryClearModal);
        if (historyClearCancelBtn) historyClearCancelBtn.addEventListener('click', closeHistoryClearModal);

        if (historyClearThisBtn) {
            historyClearThisBtn.addEventListener('click', () => {
                if (historyState.selectedEmail) {
                    vscode.postMessage({
                        command: 'clearHistorySingle',
                        email: historyState.selectedEmail,
                    });
                    closeHistoryClearModal();
                }
            });
        }

        if (historyClearAllBtn) {
            historyClearAllBtn.addEventListener('click', () => {
                vscode.postMessage({
                    command: 'clearHistoryAll',
                });
                closeHistoryClearModal();
            });
        }

        if (historyPrevBtn) {
            historyPrevBtn.addEventListener('click', () => {
                if (historyState.page > 1) {
                    historyState.page -= 1;
                    renderHistoryDetails();
                }
            });
        }

        if (historyNextBtn) {
            historyNextBtn.addEventListener('click', () => {
                historyState.page += 1;
                renderHistoryDetails();
            });
        }

        updateHistoryRangeButtons();
    }

    function handleHistoryResize() {
        if (!isHistoryTabActive()) {
            historyState.needsRender = true;
            return;
        }
        renderHistoryChart();
    }

    function normalizeHistoryRange(rangeDays) {
        if (typeof rangeDays !== 'number' || !Number.isFinite(rangeDays) || rangeDays <= 0) {
            return 7;
        }
        if (rangeDays <= 1) {
            return 1;
        }
        if (rangeDays <= 7) {
            return 7;
        }
        return 30;
    }

    function isHistoryTabActive() {
        const tab = document.getElementById('tab-history');
        return Boolean(tab && tab.classList.contains('active'));
    }

    function activateHistoryTab() {
        // Auto-switch to active account when entering tab
        const activeEmail = authorizationStatusGetter?.()?.activeAccount;
        if (activeEmail) {
            historyState.selectedEmail = activeEmail;
        }

        updateHistoryRangeButtons();
        updateHistoryAccountSelect();
        updateHistoryModelSelect();
        requestQuotaHistory();
        if (historyState.needsRender) {
            renderHistoryChart();
            renderHistoryDetails();
        }
    }

    function requestQuotaHistory() {
        if (!historyCanvas || !isHistoryTabActive()) {
            return;
        }
        const rangeDays = normalizeHistoryRange(historyState.rangeDays);
        historyState.rangeDays = rangeDays;
        vscode.postMessage({
            command: 'quotaHistory.get',
            email: historyState.selectedEmail || undefined,
            modelId: historyState.selectedModelId || undefined,
            rangeDays,
        });
    }

    function handleQuotaHistoryCleared() {
        requestQuotaHistory();
    }

    function handleQuotaHistoryData(payload) {
        const data = payload || {};
        const accounts = Array.isArray(data.accounts) ? data.accounts : [];
        historyState.accounts = accounts;
        historyState.models = Array.isArray(data.models) ? data.models : [];
        if (typeof data.rangeDays === 'number') {
            historyState.rangeDays = normalizeHistoryRange(data.rangeDays);
        }
        if (typeof data.email === 'string' && data.email.includes('@')) {
            historyState.selectedEmail = data.email;
        }
        if (typeof data.modelId === 'string') {
            historyState.selectedModelId = data.modelId;
        }
        historyState.points = Array.isArray(data.points) ? data.points : [];
        historyState.page = 1;

        updateHistoryAccountSelect();
        updateHistoryModelSelect();
        updateHistoryRangeButtons();
        updateHistoryFooter();
        if (isHistoryTabActive()) {
            renderHistoryChart();
            renderHistoryDetails();
        } else {
            historyState.needsRender = true;
        }
    }

    function updateHistoryAccountSelect() {
        if (!historyAccountSelect) {
            return;
        }
        historyAccountSelect.innerHTML = '';

        const accounts = Array.isArray(historyState.accounts) ? historyState.accounts : [];
        if (accounts.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = i18n['history.noAccounts'] || 'No accounts';
            historyAccountSelect.appendChild(option);
            historyAccountSelect.disabled = true;
            historyState.selectedEmail = null;
            return;
        }

        const activeEmail = authorizationStatusGetter?.()?.activeAccount;
        historyAccountSelect.disabled = false;
        accounts.forEach(email => {
            const option = document.createElement('option');
            option.value = email;
            const isCurrent = activeEmail && email === activeEmail;
            option.textContent = isCurrent ? `✅ ${email}` : email;
            historyAccountSelect.appendChild(option);
        });

        if (historyState.selectedEmail && accounts.includes(historyState.selectedEmail)) {
            historyAccountSelect.value = historyState.selectedEmail;
        } else if (activeEmail && accounts.includes(activeEmail)) {
            historyAccountSelect.value = activeEmail;
            historyState.selectedEmail = activeEmail;
        } else {
            historyState.selectedEmail = accounts[0];
            historyAccountSelect.value = accounts[0];
        }
    }

    function updateHistoryModelSelect() {
        if (!historyModelSelect) {
            return;
        }
        historyModelSelect.innerHTML = '';

        const models = Array.isArray(historyState.models) ? historyState.models : [];
        if (models.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = i18n['history.noModels'] || (i18n['models.empty'] || 'No models');
            historyModelSelect.appendChild(option);
            historyModelSelect.disabled = true;
            historyState.selectedModelId = null;
            return;
        }

        historyModelSelect.disabled = false;
        models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.modelId;
            option.textContent = model.label || model.modelId;
            historyModelSelect.appendChild(option);
        });

        const modelIds = models.map(model => model.modelId);
        if (!historyState.selectedModelId || !modelIds.includes(historyState.selectedModelId)) {
            historyState.selectedModelId = models[0].modelId;
        }
        historyModelSelect.value = historyState.selectedModelId || '';
    }

    function updateHistoryRangeButtons() {
        historyRangeButtons.forEach(btn => {
            const range = normalizeHistoryRange(parseInt(btn.dataset.range || '', 10));
            if (range === historyState.rangeDays) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    function getSelectedModelLabel() {
        const models = Array.isArray(historyState.models) ? historyState.models : [];
        const selected = models.find(model => model.modelId === historyState.selectedModelId);
        return selected?.label || selected?.modelId || '';
    }

    function getHistoryPoints() {
        if (!Array.isArray(historyState.points)) {
            return [];
        }
        return historyState.points
            .filter(point =>
                point
                && typeof point.timestamp === 'number'
                && Number.isFinite(point.timestamp)
                && typeof point.remainingPercentage === 'number'
                && Number.isFinite(point.remainingPercentage),
            )
            .sort((a, b) => a.timestamp - b.timestamp);
    }

    function updateHistoryFooter() {
        if (!historyMetricLabel || !historySummary) {
            return;
        }
        const modelLabel = getSelectedModelLabel();
        if (modelLabel) {
            historyMetricLabel.textContent = `${i18n['history.modelLabel'] || 'Model'}: ${modelLabel}`;
        } else {
            historyMetricLabel.textContent = '';
        }

        const points = getHistoryPoints();
        if (points.length === 0) {
            historySummary.textContent = '';
            return;
        }

        const latest = points[points.length - 1];
        const summaryParts = [];
        summaryParts.push(`${i18n['history.currentValue'] || 'Current'}: ${formatHistoryPercent(latest.remainingPercentage)}`);
        if (typeof latest.resetTime === 'number' && Number.isFinite(latest.resetTime)) {
            summaryParts.push(`${i18n['history.resetTime'] || 'Reset'}: ${formatHistoryTimestamp(latest.resetTime)}`);
        }
        if (typeof latest.countdownSeconds === 'number' && Number.isFinite(latest.countdownSeconds)) {
            summaryParts.push(`${i18n['history.countdown'] || 'Countdown'}: ${formatHistoryCountdown(latest.countdownSeconds)}`);
        }
        summaryParts.push(`${i18n['history.updatedAt'] || 'Updated'}: ${formatHistoryTimestamp(latest.timestamp)}`);
        historySummary.textContent = summaryParts.join(' · ');
    }

    function renderHistoryChart() {
        if (!historyCanvas) {
            return;
        }
        if (!isHistoryTabActive()) {
            historyState.needsRender = true;
            return;
        }

        const rect = historyCanvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            historyState.needsRender = true;
            return;
        }
        historyState.needsRender = false;

        const ctx = historyCanvas.getContext('2d');
        if (!ctx) {
            return;
        }

        const dpr = window.devicePixelRatio || 1;
        historyCanvas.width = Math.max(1, Math.round(rect.width * dpr));
        historyCanvas.height = Math.max(1, Math.round(rect.height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);

        const points = getHistoryPoints();
        const hasPoints = points.length > 0;
        if (historyEmpty) {
            const emptyMessage = historyState.accounts.length === 0
                ? (i18n['history.noAccounts'] || 'No accounts')
                : (historyState.models.length === 0
                    ? (i18n['history.noModels'] || 'No models')
                    : (i18n['history.noData'] || 'No history yet.'));
            historyEmpty.textContent = emptyMessage;
            historyEmpty.classList.toggle('hidden', hasPoints);
        }
        if (!hasPoints) {
            return;
        }

        const width = rect.width;
        const height = rect.height;
        const padding = {
            left: 52,
            right: 20,
            top: 20,
            bottom: 42,
        };
        const chartWidth = Math.max(1, width - padding.left - padding.right);
        const chartHeight = Math.max(1, height - padding.top - padding.bottom);
        const now = Date.now();
        const rangeMs = normalizeHistoryRange(historyState.rangeDays) * 24 * 60 * 60 * 1000;
        const startTime = now - rangeMs;
        const endTime = now;

        const accent = getCssVar('--accent', '#2f81f7');
        const gridColor = getCssVar('--border-color', 'rgba(255,255,255,0.08)');
        const textSecondary = getCssVar('--text-secondary', '#8b949e');

        ctx.save();
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        for (let i = 0; i <= 5; i++) {
            const y = padding.top + (chartHeight / 5) * i;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(width - padding.right, y);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();

        ctx.save();
        ctx.fillStyle = textSecondary;
        ctx.font = `11px ${getCssVar('--font-family', 'sans-serif')}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const labelX = Math.max(12, padding.left - 8);
        for (let i = 0; i <= 5; i++) {
            const value = 100 - i * 20;
            const y = padding.top + (chartHeight / 5) * i;
            ctx.fillText(`${value}%`, labelX, y);
        }
        ctx.restore();

        // Draw Time Axis Labels (Data-Driven)
        ctx.save();
        ctx.fillStyle = textSecondary;
        ctx.font = `11px ${getCssVar('--font-family', 'sans-serif')}`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';

        const labelY = padding.top + chartHeight + 12;
        const minLabelDist = 60; // minimum pixels between label centers
        let lastLabelX = -1;

        // Iterate backwards (from right to left) to prioritize latest data
        // We calculate coords for all points first to know where to draw text
        const pointCoords = points.map(point => {
            const ratio = (point.timestamp - startTime) / (endTime - startTime);
            return {
                x: padding.left + Math.min(1, Math.max(0, ratio)) * chartWidth,
                timestamp: point.timestamp
            };
        });

        // We process points from right (newest) to left (oldest)
        // strict logic: rightmost point always shows (if inside view),
        // then others show only if enough space.
        const reversedCoords = [...pointCoords].reverse();

        reversedCoords.forEach((coord, index) => {
            // Always try to show the latest point (index 0)
            // Or if distance is enough from the previously drawn label (which is to the right)

            // Note: Since we go Right -> Left, 'lastLabelX' represents the label *to the right*.
            // So we check if (lastLabelX - coord.x) >= minLabelDist

            const isLatest = (index === 0);
            const canDraw = (lastLabelX === -1) || ((lastLabelX - coord.x) >= minLabelDist);

            if (isLatest || canDraw) {
                const date = new Date(coord.timestamp);
                let labelParts = [];
                if (historyState.rangeDays <= 1) {
                    labelParts = [
                        String(date.getHours()).padStart(2, '0') + ':' +
                        String(date.getMinutes()).padStart(2, '0')
                    ];
                } else {
                    labelParts = [
                        String(date.getMonth() + 1).padStart(2, '0') + '-' +
                        String(date.getDate()).padStart(2, '0')
                    ];
                }
                const labelText = labelParts.join(' ');

                // Boundary check: ensure label doesn't go off-canvas too much
                // Simple logic: clamp text position or alignment

                // Draw tick mark (optional, but helps alignment)
                ctx.globalAlpha = 0.5;
                ctx.beginPath();
                ctx.moveTo(coord.x, padding.top + chartHeight);
                ctx.lineTo(coord.x, padding.top + chartHeight + 5);
                ctx.stroke();
                ctx.globalAlpha = 1.0;

                ctx.fillText(labelText, coord.x, labelY);
                lastLabelX = coord.x;
            }
        });
        ctx.restore();

        const coords = points.map(point => {
            const clamped = Math.min(100, Math.max(0, point.remainingPercentage));
            const ratio = (point.timestamp - startTime) / (endTime - startTime);
            const x = padding.left + Math.min(1, Math.max(0, ratio)) * chartWidth;
            const y = padding.top + (1 - clamped / 100) * chartHeight;
            return { x, y, raw: point };
        });

        if (coords.length === 1) {
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.arc(coords[0].x, coords[0].y, 3, 0, Math.PI * 2);
            ctx.fill();
            return;
        }

        ctx.save();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.moveTo(coords[0].x, coords[0].y);
        coords.forEach(point => ctx.lineTo(point.x, point.y));
        ctx.lineTo(coords[coords.length - 1].x, padding.top + chartHeight);
        ctx.lineTo(coords[0].x, padding.top + chartHeight);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        coords.forEach((point, index) => {
            if (index === 0) {
                ctx.moveTo(point.x, point.y);
            } else {
                ctx.lineTo(point.x, point.y);
            }
        });
        ctx.stroke();

        ctx.fillStyle = accent;
        coords.forEach(point => {
            ctx.beginPath();
            ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
            ctx.fill();
        });

        const last = coords[coords.length - 1];
        ctx.beginPath();
        ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
    }

    function renderHistoryDetails() {
        if (!historyTableBody || !historyPageInfo || !historyPrevBtn || !historyNextBtn) {
            return;
        }

        const pointsDesc = getHistoryPoints().slice().sort((a, b) => b.timestamp - a.timestamp);
        const total = pointsDesc.length;
        const pageSize = historyState.pageSize;
        const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;

        if (total === 0) {
            historyTableBody.innerHTML = '';
            if (historyTableEmpty) {
                historyTableEmpty.textContent = i18n['history.tableEmpty'] || (i18n['history.noData'] || 'No data');
                historyTableEmpty.classList.remove('hidden');
            }
            historyPageInfo.textContent = '';
            historyPrevBtn.disabled = true;
            historyNextBtn.disabled = true;
            return;
        }

        if (historyTableEmpty) {
            historyTableEmpty.classList.add('hidden');
        }

        historyState.page = Math.min(Math.max(historyState.page, 1), totalPages);
        const start = (historyState.page - 1) * pageSize;
        const pagePoints = pointsDesc.slice(start, start + pageSize);

        historyTableBody.innerHTML = pagePoints.map((point, index) => {
            const nextPoint = pointsDesc[start + index + 1];
            const delta = nextPoint
                ? point.remainingPercentage - nextPoint.remainingPercentage
                : null;
            const deltaText = delta === null ? '--' : formatHistoryDelta(delta);
            const deltaClass = delta === null
                ? 'neutral'
                : (delta > 0 ? 'positive' : (delta < 0 ? 'negative' : 'neutral'));

            return `
                <tr>
                    <td>${formatHistoryTimestamp(point.timestamp)}</td>
                    <td>${formatHistoryPercent(point.remainingPercentage)}</td>
                    <td class="history-delta ${deltaClass}">${deltaText}</td>
                    <td>${formatHistoryTimestamp(point.resetTime)}</td>
                    <td>${formatHistoryCountdownLabel(point.countdownSeconds, point.isStart, point.isReset)}</td>
                </tr>
            `;
        }).join('');

        const pageInfo = i18n['history.pageInfo'] || 'Page {current} / {total}';
        historyPageInfo.textContent = pageInfo
            .replace('{current}', String(historyState.page))
            .replace('{total}', String(totalPages));
        historyPrevBtn.disabled = historyState.page <= 1;
        historyNextBtn.disabled = historyState.page >= totalPages;
    }

    function formatHistoryPercent(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return '--';
        }
        const rounded = Math.round(value * 10) / 10;
        return `${rounded}%`;
    }

    function formatHistoryDelta(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return '--';
        }
        const rounded = Math.round(value * 10) / 10;
        const sign = rounded > 0 ? '+' : '';
        return `${sign}${rounded}%`;
    }

    function formatHistoryCountdown(seconds) {
        if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
            return '--';
        }
        if (seconds <= 0) {
            return i18n['dashboard.online'] || 'Restoring Soon';
        }
        const totalMinutes = Math.ceil(seconds / 60);
        if (totalMinutes < 60) {
            return `${totalMinutes}m`;
        }
        const totalHours = Math.floor(totalMinutes / 60);
        const remainingMinutes = totalMinutes % 60;
        if (totalHours < 24) {
            return `${totalHours}h ${remainingMinutes}m`;
        }
        const days = Math.floor(totalHours / 24);
        const remainingHours = totalHours % 24;
        return `${days}d ${remainingHours}h ${remainingMinutes}m`;
    }

    function formatHistoryCountdownLabel(seconds, isStart, isReset) {
        const text = formatHistoryCountdown(seconds);
        if (!isStart && !isReset) {
            return text;
        }

        let badges = '';
        if (isStart) {
            badges += '<span class="tag-start">START</span>';
        }
        if (isReset) {
            badges += '<span class="tag-reset">RESET</span>';
        }

        if (text === '--') {
            return badges;
        }
        return `${text} ${badges}`;
    }

    function formatHistoryTimestamp(timestamp) {
        if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
            return '--';
        }
        return new Date(timestamp).toLocaleString();
    }

    function getCssVar(name, fallback) {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name);
        const trimmed = value ? value.trim() : '';
        return trimmed || fallback;
    }

    return {
        initHistoryTab,
        handleHistoryResize,
        activateHistoryTab,
        handleQuotaHistoryData,
        handleQuotaHistoryCleared,
        requestQuotaHistory,
        isHistoryTabActive,
    };
}
