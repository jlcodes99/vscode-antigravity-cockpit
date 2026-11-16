import {
    formatGroupStatusText,
    formatQuotaWindowShortLabel,
} from './status_bar_text';

const thresholds = { warningThreshold: 30, criticalThreshold: 10 };

const argonWindows = [
    { windowId: 'gemini-argon-5h', windowName: 'Gemini 4 Argon (5h)', remainingPercentage: 42, quotaBucketType: 'SHORT_TERM' },
    { windowId: 'gemini-argon-wtu-weekly', windowName: 'Gemini 4 Argon (Weekly)', remainingPercentage: 91, quotaBucketType: 'LONG_TERM' },
];

describe('formatQuotaWindowShortLabel', () => {
    it('SHORT_TERM / 5h → 5h', () => {
        expect(formatQuotaWindowShortLabel(argonWindows[0])).toBe('5h');
        expect(formatQuotaWindowShortLabel({ windowName: '5-hour limit' })).toBe('5h');
    });

    it('LONG_TERM / weekly → Week', () => {
        expect(formatQuotaWindowShortLabel(argonWindows[1])).toBe('Week');
    });

    it('monthly → Mo', () => {
        expect(formatQuotaWindowShortLabel({ windowName: 'Monthly Quota' })).toBe('Mo');
    });

    it('未知窗口回退为窗口名前缀', () => {
        expect(formatQuotaWindowShortLabel({ windowName: 'Pro Pool' })).toBe('Pro P');
        expect(formatQuotaWindowShortLabel({})).toBe('Q');
    });
});

describe('formatGroupStatusText — 多窗口', () => {
    it('standard：状态球 + 组名 + 每个窗口的短标签与百分比', () => {
        const text = formatGroupStatusText('standard', 'Argon', argonWindows, 42, thresholds);
        expect(text).toBe('🟢 Argon: 5h 42% · Week 91%');
    });

    it('namePercent：无状态球，逐窗口列出', () => {
        const text = formatGroupStatusText('namePercent', 'Argon', argonWindows, 42, thresholds);
        expect(text).toBe('Argon: 5h 42% · Week 91%');
    });

    it('compact：状态球 + 各窗口百分比', () => {
        const text = formatGroupStatusText('compact', 'Argon', argonWindows, 42, thresholds);
        expect(text).toBe('🟢 42% · 91%');
    });

    it('percent：仅各窗口百分比', () => {
        const text = formatGroupStatusText('percent', 'Argon', argonWindows, 42, thresholds);
        expect(text).toBe('42% · 91%');
    });

    it('dot：仅最紧张窗口的状态球', () => {
        const text = formatGroupStatusText('dot', 'Argon', argonWindows, 42, thresholds);
        expect(text).toBe('🟢');
    });

    it('icon：返回空（由调用方统一处理）', () => {
        expect(formatGroupStatusText('icon', 'Argon', argonWindows, 42, thresholds)).toBe('');
    });

    it('窗口百分比为空时回退组百分比', () => {
        const text = formatGroupStatusText(
            'standard',
            'Argon',
            [{ windowName: 'Gemini 4 Argon (5h)' }, argonWindows[1]],
            42,
            thresholds,
        );
        expect(text).toBe('🟢 Argon: 5h 42% · Week 91%');
    });
});

describe('formatGroupStatusText — 单窗口/无窗口（保持原行为）', () => {
    it('standard 单值不带窗口标签', () => {
        const single = [{ windowId: 'x', windowName: 'Model Quota', remainingPercentage: 66 }];
        expect(formatGroupStatusText('standard', 'Gemini', single, 66, thresholds)).toBe('🟢 Gemini: 66%');
    });

    it('无窗口数据时退化为组百分比', () => {
        expect(formatGroupStatusText('standard', 'Gemini', undefined, 66, thresholds)).toBe('🟢 Gemini: 66%');
        expect(formatGroupStatusText('compact', 'Gemini', [], 66, thresholds)).toBe('🟢 66%');
    });

    it('状态球按阈值变化', () => {
        const warn = [{ windowName: 'X', remainingPercentage: 20 }];
        const crit = [{ windowName: 'X', remainingPercentage: 5 }];
        expect(formatGroupStatusText('dot', 'G', warn, 20, thresholds)).toBe('🟡');
        expect(formatGroupStatusText('dot', 'G', crit, 5, thresholds)).toBe('🔴');
    });
});
