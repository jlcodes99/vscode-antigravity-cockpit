
import * as vscode from 'vscode';
import { CockpitConfig } from '../shared/config_service';
import { t } from '../shared/i18n';
import { QuotaSnapshot } from '../shared/types';
import { STATUS_BAR_FORMAT, QUOTA_THRESHOLDS } from '../shared/constants';

export class StatusBarController {
    private statusBarItem: vscode.StatusBarItem;

    constructor(context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100,
        );
        this.statusBarItem.command = 'agCockpit.open';
        this.statusBarItem.text = `$(rocket) ${t('statusBar.init')}`;
        this.statusBarItem.tooltip = t('statusBar.tooltip');
        this.statusBarItem.show();

        context.subscriptions.push(this.statusBarItem);
    }

    public update(snapshot: QuotaSnapshot, config: CockpitConfig): void {
        // 仅图标模式：直接显示 🚀
        if (config.statusBarFormat === STATUS_BAR_FORMAT.ICON) {
            this.statusBarItem.text = '🚀';
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.tooltip = this.generateQuotaTooltip(snapshot, config);
            return;
        }

        const statusTextParts: string[] = [];
        let minPercentage = 100;

        // 检查是否启用分组显示
        if (config.groupingEnabled && config.groupingShowInStatusBar && snapshot.groups && snapshot.groups.length > 0) {
            // 获取置顶的分组
            const monitoredGroups = snapshot.groups.filter(g =>
                config.pinnedGroups.includes(g.groupId),
            );

            if (monitoredGroups.length > 0) {
                // 对置顶分组按 config.groupOrder 排序
                if (config.groupOrder.length > 0) {
                    monitoredGroups.sort((a, b) => {
                        const idxA = config.groupOrder.indexOf(a.groupId);
                        const idxB = config.groupOrder.indexOf(b.groupId);
                        // 如果都在排序列表中，按列表顺序
                        if (idxA !== -1 && idxB !== -1) { return idxA - idxB; }
                        // 如果一个在列表一个不在，在列表的优先
                        if (idxA !== -1) { return -1; }
                        if (idxB !== -1) { return 1; }
                        // 都不在，保持原序
                        return 0;
                    });
                }

                // 显示置顶分组
                monitoredGroups.forEach(g => {
                    const pct = g.remainingPercentage;
                    const text = this.formatStatusBarText(g.groupName, pct, config.statusBarFormat, config);
                    if (text) { statusTextParts.push(text); }
                    if (pct < minPercentage) {
                        minPercentage = pct;
                    }
                });
            } else {
                // 显示最低配额分组
                let lowestPct = 100;
                let lowestGroup = snapshot.groups[0];

                snapshot.groups.forEach(g => {
                    const pct = g.remainingPercentage;
                    if (pct < lowestPct) {
                        lowestPct = pct;
                        lowestGroup = g;
                    }
                });

                if (lowestGroup) {
                    const text = this.formatStatusBarText(lowestGroup.groupName, lowestPct, config.statusBarFormat, config);
                    if (text) {
                        statusTextParts.push(text);
                    } else {
                        // 仅状态球或仅数字模式时，显示最低的
                        const dot = this.getStatusIcon(lowestPct, config);
                        statusTextParts.push(config.statusBarFormat === STATUS_BAR_FORMAT.DOT ? dot : `${Math.floor(lowestPct)}%`);
                    }
                    minPercentage = lowestPct;
                }
            }
        } else {
            // 原始逻辑：显示模型
            // 获取置顶的模型
            const monitoredModels = snapshot.models.filter(m =>
                config.pinnedModels.some(p =>
                    p.toLowerCase() === m.modelId.toLowerCase() ||
                    p.toLowerCase() === m.label.toLowerCase(),
                ),
            );

            if (monitoredModels.length > 0) {
                // 对置顶模型按 config.modelOrder 排序
                if (config.modelOrder.length > 0) {
                    monitoredModels.sort((a, b) => {
                        const idxA = config.modelOrder.indexOf(a.modelId);
                        const idxB = config.modelOrder.indexOf(b.modelId);
                        if (idxA !== -1 && idxB !== -1) { return idxA - idxB; }
                        if (idxA !== -1) { return -1; }
                        if (idxB !== -1) { return 1; }
                        return 0;
                    });
                }

                // 显示置顶模型
                monitoredModels.forEach(m => {
                    const pct = m.remainingPercentage ?? 0;
                    // 使用自定义名称（如果存在）
                    const displayName = config.modelCustomNames?.[m.modelId] || m.label;
                    const text = this.formatStatusBarText(displayName, pct, config.statusBarFormat, config);
                    if (text) { statusTextParts.push(text); }
                    if (pct < minPercentage) {
                        minPercentage = pct;
                    }
                });
            } else {
                // 显示最低配额模型
                let lowestPct = 100;
                let lowestModel = snapshot.models[0];

                snapshot.models.forEach(m => {
                    const pct = m.remainingPercentage ?? 0;
                    if (pct < lowestPct) {
                        lowestPct = pct;
                        lowestModel = m;
                    }
                });

                if (lowestModel) {
                    // 使用自定义名称（如果存在）
                    const displayName = config.modelCustomNames?.[lowestModel.modelId] || lowestModel.label;
                    const text = this.formatStatusBarText(displayName, lowestPct, config.statusBarFormat, config);
                    if (text) {
                        statusTextParts.push(text);
                    } else {
                        // 仅状态球或仅数字模式时，显示最低的
                        const dot = this.getStatusIcon(lowestPct, config);
                        statusTextParts.push(config.statusBarFormat === STATUS_BAR_FORMAT.DOT ? dot : `${Math.floor(lowestPct)}%`);
                    }
                    minPercentage = lowestPct;
                }
            }
        }

        // 更新状态栏
        if (statusTextParts.length > 0) {
            this.statusBarItem.text = statusTextParts.join(' | ');
        } else {
            this.statusBarItem.text = '🟢';
        }

        // 移除背景色，改用每个项目前的颜色球区分
        this.statusBarItem.backgroundColor = undefined;

        // 更新悬浮提示 - 卡片式布局显示配额详情
        this.statusBarItem.tooltip = this.generateQuotaTooltip(snapshot, config);
    }

    public setLoading(text?: string): void {
        this.statusBarItem.text = `$(sync~spin) ${text || t('statusBar.connecting')}`;
        this.statusBarItem.backgroundColor = undefined;
    }

    public setOffline(): void {
        this.statusBarItem.text = `$(error) ${t('statusBar.offline')}`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    public setError(message: string): void {
        this.statusBarItem.text = `$(error) ${t('status.error')}`;
        this.statusBarItem.tooltip = message;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }

    public setReady(): void {
        this.statusBarItem.text = `$(rocket) ${t('statusBar.ready')}`;
        this.statusBarItem.backgroundColor = undefined;
    }

    public reset(): void {
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.tooltip = t('statusBar.tooltip');
    }

    private generateQuotaTooltip(snapshot: QuotaSnapshot, config: CockpitConfig): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportHtml = true;

        // 标题行
        const planInfo = snapshot.userInfo?.planName ? ` | ${snapshot.userInfo.planName}` : '';
        md.appendMarkdown(`**🚀 ${t('dashboard.title')}${planInfo}**\n\n`);

        // 排序逻辑与仪表盘保持一致
        const sortedModels = [...snapshot.models];
        if (config.modelOrder && config.modelOrder.length > 0) {
            // 有自定义顺序时，按用户拖拽设置的顺序排序
            const orderMap = new Map<string, number>();
            config.modelOrder.forEach((id, index) => orderMap.set(id, index));
            sortedModels.sort((a, b) => {
                const idxA = orderMap.has(a.modelId) ? orderMap.get(a.modelId)! : 99999;
                const idxB = orderMap.has(b.modelId) ? orderMap.get(b.modelId)! : 99999;
                return idxA - idxB;
            });
        }
        // 没有自定义顺序时，保持 API 返回的原始顺序

        // 构建 Markdown 表格
        md.appendMarkdown('| | | |\n');
        md.appendMarkdown('| :--- | :--- | :--- |\n');

        for (const model of sortedModels) {
            const pct = model.remainingPercentage ?? 0;
            const icon = this.getStatusIcon(pct, config);
            const bar = this.generateCompactProgressBar(pct);
            const resetTime = model.timeUntilResetFormatted || '-';

            // 使用完整模型名称
            const pctDisplay = (Math.floor(pct * 100) / 100).toFixed(2);
            md.appendMarkdown(`| ${icon} **${model.label}** | \`${bar}\` | ${pctDisplay}% → ${resetTime} |\n`);
        }

        // 底部提示
        md.appendMarkdown(`\n---\n*${t('statusBar.tooltip')}*`);

        return md;
    }

    private generateCompactProgressBar(percentage: number): string {
        const total = 10;
        const filled = Math.round((percentage / 100) * total);
        const empty = total - filled;
        // 使用 ■ (U+25A0) 和 □ (U+25A1) 在 Windows UI 字体下通常宽度一致
        // 之前的 █ (Full Block) 和 ░ (Light Shade) 在非等宽字体下宽度差异巨大
        return '■'.repeat(filled) + '□'.repeat(empty);
    }

    private getStatusIcon(percentage: number, config?: CockpitConfig): string {
        const warningThreshold = config?.warningThreshold ?? QUOTA_THRESHOLDS.WARNING_DEFAULT;
        const criticalThreshold = config?.criticalThreshold ?? QUOTA_THRESHOLDS.CRITICAL_DEFAULT;

        if (percentage <= criticalThreshold) { return '🔴'; }  // 危险
        if (percentage <= warningThreshold) { return '🟡'; }    // 警告
        return '🟢'; // 健康
    }

    private formatStatusBarText(label: string, percentage: number, format: string, config?: CockpitConfig): string {
        const dot = this.getStatusIcon(percentage, config);
        const pct = `${Math.floor(percentage)}%`;

        switch (format) {
            case STATUS_BAR_FORMAT.ICON:
                // 仅图标模式：返回空字符串，由 update 统一处理显示🚀
                return '';
            case STATUS_BAR_FORMAT.DOT:
                // 仅状态球模式
                return dot;
            case STATUS_BAR_FORMAT.PERCENT:
                // 仅数字模式
                return pct;
            case STATUS_BAR_FORMAT.COMPACT:
                // 状态球 + 数字
                return `${dot} ${pct}`;
            case STATUS_BAR_FORMAT.NAME_PERCENT:
                // 模型名 + 数字（无状态球）
                return `${label}: ${pct}`;
            case STATUS_BAR_FORMAT.STANDARD:
            default:
                // 状态球 + 模型名 + 数字（默认）
                return `${dot} ${label}: ${pct}`;
        }
    }
}
