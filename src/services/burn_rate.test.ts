import {
    predictBurnRate,
    extractCurrentCycle,
    projectBurnRate,
    BurnRatePoint,
} from './burn_rate';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const HOUR = 3_600_000;

function point(hoursAgo: number, pct: number, extra: Partial<BurnRatePoint> = {}): BurnRatePoint {
    return {
        timestamp: NOW - hoursAgo * HOUR,
        remainingPercentage: pct,
        ...extra,
    };
}

/** 过去 6 小时每小时降 10%，最新点 40%，重置时刻在 4 小时后（时间升序） */
function steadyDecline(): BurnRatePoint[] {
    return [6, 5, 4, 3, 2, 1, 0].map(hAgo =>
        point(hAgo, 40 + hAgo * 10, hAgo === 6 ? { isStart: true } : hAgo === 0 ? { resetTime: NOW + 4 * HOUR } : {}),
    );
}

describe('extractCurrentCycle', () => {
    it('从最后一个 isReset 标记起算', () => {
        const points = [
            point(20, 100, { isReset: true }),
            point(19, 80),
            point(10, 95, { isReset: true }),
            point(9, 85),
            point(8, 70),
        ].reverse();
        const cycle = extractCurrentCycle(points, NOW);
        expect(cycle).toHaveLength(3);
        expect(cycle[0].remainingPercentage).toBe(95);
    });

    it('无标记时遇到未标记的回升从回升处截断', () => {
        const points = [
            point(6, 100),
            point(5, 60),
            point(4, 90), // 未标记重置
            point(3, 80),
            point(2, 70),
        ].reverse();
        const cycle = extractCurrentCycle(points, NOW);
        expect(cycle.map(p => p.remainingPercentage)).toEqual([90, 80, 70]);
    });

    it('过滤未来时间点与异常百分比', () => {
        const points = [
            point(2, 100),
            { timestamp: NOW + HOUR, remainingPercentage: 120 },
            { timestamp: NOW - HOUR, remainingPercentage: 150 },
        ];
        const cycle = extractCurrentCycle(points, NOW);
        expect(cycle).toHaveLength(1);
        expect(cycle[0].remainingPercentage).toBe(100);
    });
});

describe('predictBurnRate', () => {
    it('稳定消耗：速率 10%/h，4 小时后耗尽，早于重置', () => {
        const result = predictBurnRate(steadyDecline(), NOW);
        expect(result.burnRatePctPerHour).toBeCloseTo(10, 5);
        expect(result.confidence).toBe('high');
        expect(result.projectedExhaustAt).toBe(NOW + 4 * HOUR);
        expect(result.willExhaustBeforeReset).toBe(true);
        expect(result.projectedRemainingAtReset).toBeCloseTo(0, 5);
    });

    it('重置前用不完时不报警', () => {
        // 每小时只耗 2%，最新 40%，重置 4h 后 → 重置时还剩 32%
        const points = [4, 3, 2, 1, 0].map(hAgo =>
            point(hAgo, 40 + hAgo * 2, hAgo === 0 ? { resetTime: NOW + 4 * HOUR } : {}),
        );
        const result = predictBurnRate(points, NOW);
        expect(result.willExhaustBeforeReset).toBe(false);
        expect(result.projectedRemainingAtReset).toBeCloseTo(32, 5);
    });

    it('样本不足返回空预测', () => {
        const result = predictBurnRate([point(1, 90), point(0, 80)], NOW);
        expect(result.projectedExhaustAt).toBeUndefined();
        expect(result.sampleCount).toBe(0);
    });

    it('样本时间跨度不足（<30min）不预测', () => {
        const points = [0, 0.1, 0.2, 0.3].map(hAgo =>
            point(hAgo, 80 + hAgo * 10),
        ).reverse();
        const result = predictBurnRate(points, NOW);
        expect(result.spanHours).toBeLessThan(0.5);
        expect(result.projectedExhaustAt).toBeUndefined();
    });

    it('配额不下降（斜率非负）不预测耗尽', () => {
        const points = [0, 1, 2, 3].map(hAgo => point(hAgo, 50)).reverse();
        const result = predictBurnRate(points, NOW);
        expect(result.burnRatePctPerHour).toBe(0);
        expect(result.projectedExhaustAt).toBeUndefined();
    });

    it('resetTime 缺失时回退用 countdownSeconds', () => {
        const points = [4, 3, 2, 1, 0].map(hAgo =>
            point(hAgo, 40 + hAgo * 10, hAgo === 0 ? { countdownSeconds: 4 * 3600 } : {}),
        );
        const result = predictBurnRate(points, NOW);
        expect(result.resetAt).toBe(NOW + 4 * HOUR);
    });

    it('低置信度（高抖动）不给出耗尽时刻', () => {
        // 剧烈抖动使 R² 很低
        const points = [
            point(4, 100),
            point(3, 20),
            point(2, 90),
            point(1, 30),
            point(0, 80),
        ];
        const result = predictBurnRate(points, NOW);
        expect(result.confidence).toBe('low');
        expect(result.projectedExhaustAt).toBeUndefined();
    });

    it('历史倒计时以采样时刻为起点，不随查询时间延后', () => {
        const points = [2, 1, 0.25].map(hAgo => point(hAgo, 40 + hAgo * 10, { countdownSeconds: 3600 }));
        expect(predictBurnRate(points, NOW).resetAt).toBe(NOW + 0.75 * HOUR);
    });

    it('重置已过去时不回退旧倒计时，也不再预测旧周期', () => {
        const points = steadyDecline();
        points[points.length - 1].resetTime = NOW - 1;
        points[points.length - 1].countdownSeconds = 3600;
        expect(predictBurnRate(points, NOW).projectedExhaustAt).toBeUndefined();
    });

    it('停止采样后不继续显示旧速率的耗尽警告', () => {
        expect(predictBurnRate(steadyDecline(), NOW + HOUR).projectedExhaustAt).toBeUndefined();
    });

    it('长周期预测截到 12 小时后时仍显示 48% 而非提前耗尽', () => {
        const points = [2, 1, 0].map(hAgo => point(hAgo, 60 + hAgo, { resetTime: NOW + 72 * HOUR }));
        const prediction = predictBurnRate(points, NOW);
        expect(prediction.projectedExhaustAt).toBe(NOW + 60 * HOUR);
        expect(projectBurnRate(points[2], prediction, NOW + 12 * HOUR)).toEqual({
            timestamp: NOW + 12 * HOUR,
            remainingPercentage: 48,
        });
    });

    it('重置早于耗尽时，虚线停在重置时刻的实际预测余量', () => {
        const points = [2, 1, 0].map(hAgo => point(hAgo, 60 + hAgo, { resetTime: NOW + 4 * HOUR }));
        expect(projectBurnRate(points[2], predictBurnRate(points, NOW), NOW + 12 * HOUR)).toEqual({
            timestamp: NOW + 4 * HOUR,
            remainingPercentage: 56,
        });
    });
});
