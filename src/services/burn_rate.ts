/**
 * Burn-rate（配额消耗速率）预测：纯函数层。
 *
 * 输入 quota_history 记录的百分比时间点，取"当前配额周期"（最后一次
 * isReset/isStart 标记之后的单调下降段）做最小二乘线性回归，
 * 估算每小时消耗百分比与耗尽时刻，并用 R² 给出置信度。
 */

export interface BurnRatePoint {
    timestamp: number;
    remainingPercentage: number;
    isStart?: boolean;
    isReset?: boolean;
    /** 配额重置时刻（ms） */
    resetTime?: number;
    /** 距重置秒数 */
    countdownSeconds?: number;
}

export type BurnRateConfidence = 'high' | 'medium' | 'low';

export interface BurnRatePrediction {
    /** 每小时消耗的配额百分比（正数）；未在消耗时为 0 */
    burnRatePctPerHour: number;
    /** 预计耗尽时刻（ms）；无法预测时为 undefined */
    projectedExhaustAt: number | undefined;
    /** 按当前速率，到达重置时刻时的剩余百分比（0-100，可为负） */
    projectedRemainingAtReset: number | undefined;
    /** 是否会在配额重置前耗尽 */
    willExhaustBeforeReset: boolean;
    /** 预测依据样本数 */
    sampleCount: number;
    /** 样本覆盖时长（小时） */
    spanHours: number;
    confidence: BurnRateConfidence;
    /** 重置时刻（ms，取自最新数据点） */
    resetAt: number | undefined;
}

const MIN_SAMPLE_COUNT = 3;
const MIN_SPAN_HOURS = 0.5; // 30 分钟内的抖动不足以拟合趋势
const HOUR_MS = 3_600_000;
const MAX_SAMPLE_AGE_MS = 30 * 60 * 1000;

/**
 * 截取当前配额周期的有效燃烧段：
 * 最后一个 isReset/isStart 标记之后的点；若没有标记则取尾部最长单调下降段。
 */
export function extractCurrentCycle(points: readonly BurnRatePoint[], now: number): BurnRatePoint[] {
    if (points.length === 0) {
        return [];
    }
    const sorted = points
        .filter(
            p => Number.isFinite(p.timestamp)
                && p.timestamp <= now
                && Number.isFinite(p.remainingPercentage)
                && p.remainingPercentage >= 0
                && p.remainingPercentage <= 100,
        )
        .sort((a, b) => a.timestamp - b.timestamp);

    let lastCycleStart = 0;
    for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].isReset || sorted[i].isStart) {
            lastCycleStart = i;
        }
    }

    let cycle = sorted.slice(lastCycleStart);

    // 丢弃百分比回升之前的段——若发生未标记的重置，从最后一次明显回升处重新起算
    let cutIndex = 0;
    for (let i = 1; i < cycle.length; i++) {
        if (cycle[i].remainingPercentage > cycle[i - 1].remainingPercentage + 0.01) {
            cutIndex = i;
        }
    }
    if (cutIndex > 0) {
        cycle = cycle.slice(cutIndex);
    }

    return cycle;
}

interface RegressionResult {
    /** 斜率：百分比/小时（负值表示消耗） */
    slope: number;
    intercept: number;
    r2: number;
}

function linearRegression(points: readonly BurnRatePoint[]): RegressionResult | null {
    const n = points.length;
    if (n < 2) {
        return null;
    }
    const t0 = points[0].timestamp;
    const xs = points.map(p => (p.timestamp - t0) / HOUR_MS);
    const ys = points.map(p => p.remainingPercentage);

    const meanX = xs.reduce((s, x) => s + x, 0) / n;
    const meanY = ys.reduce((s, y) => s + y, 0) / n;

    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - meanX;
        const dy = ys[i] - meanY;
        sxx += dx * dx;
        sxy += dx * dy;
        syy += dy * dy;
    }
    if (sxx === 0) {
        return null;
    }

    const slope = sxy / sxx;
    const intercept = meanY - slope * meanX;
    const sse = ys.reduce((sum, y, i) => {
        const fitted = slope * xs[i] + intercept;
        return sum + (y - fitted) ** 2;
    }, 0);
    const r2 = syy === 0 ? 1 : Math.max(0, 1 - sse / syy);

    return { slope, intercept, r2 };
}

function confidenceFromR2(r2: number): BurnRateConfidence {
    if (r2 >= 0.7) {
        return 'high';
    }
    if (r2 >= 0.4) {
        return 'medium';
    }
    return 'low';
}

/**
 * 基于历史点预测配额耗尽时间。
 * @param now 当前时刻（ms），默认 Date.now()
 */
export function predictBurnRate(
    points: readonly BurnRatePoint[],
    now: number = Date.now(),
): BurnRatePrediction {
    const empty: BurnRatePrediction = {
        burnRatePctPerHour: 0,
        projectedExhaustAt: undefined,
        projectedRemainingAtReset: undefined,
        willExhaustBeforeReset: false,
        sampleCount: 0,
        spanHours: 0,
        confidence: 'low',
        resetAt: undefined,
    };

    const cycle = extractCurrentCycle(points, now);
    if (cycle.length < MIN_SAMPLE_COUNT) {
        return empty;
    }

    const latest = cycle[cycle.length - 1];
    // A historical cycle must not keep predicting after monitoring stops or it resets.
    let resetAt: number | undefined;
    if (Number.isFinite(latest.resetTime) && latest.resetTime! > 0) {
        resetAt = latest.resetTime;
    } else if (Number.isFinite(latest.countdownSeconds) && latest.countdownSeconds! > 0) {
        resetAt = latest.timestamp + latest.countdownSeconds! * 1000;
    }
    if (now - latest.timestamp > MAX_SAMPLE_AGE_MS || (resetAt !== undefined && resetAt <= now)) {
        return empty;
    }

    const regression = linearRegression(cycle);
    if (!regression || regression.slope >= 0) {
        // 斜率非负 = 当前周期没有净消耗，不预测耗尽
        return { ...empty, sampleCount: cycle.length };
    }

    const spanHours = (cycle[cycle.length - 1].timestamp - cycle[0].timestamp) / HOUR_MS;
    if (spanHours < MIN_SPAN_HOURS) {
        return { ...empty, sampleCount: cycle.length, spanHours };
    }

    const confidence = confidenceFromR2(regression.r2);
    const burnRate = Math.abs(regression.slope);

    // 用最新实测点（而非拟合线终点）做预测锚点，减少末端偏差
    const hoursToExhaustFromLatest = Math.max(0, latest.remainingPercentage) / burnRate;
    const projectedExhaustAt = confidence === 'low'
        ? undefined
        : latest.timestamp + hoursToExhaustFromLatest * HOUR_MS;

    if (projectedExhaustAt !== undefined && projectedExhaustAt <= now) {
        return empty;
    }

    let projectedRemainingAtReset: number | undefined;
    let willExhaustBeforeReset = false;
    if (projectedExhaustAt && resetAt) {
        const hoursFromLatestToReset = (resetAt - latest.timestamp) / HOUR_MS;
        projectedRemainingAtReset = Math.max(
            0,
            latest.remainingPercentage - burnRate * hoursFromLatestToReset,
        );
        willExhaustBeforeReset = projectedExhaustAt <= resetAt;
    }

    return {
        burnRatePctPerHour: burnRate,
        projectedExhaustAt,
        projectedRemainingAtReset,
        willExhaustBeforeReset,
        sampleCount: cycle.length,
        spanHours,
        confidence,
        resetAt,
    };
}

/** Clip both coordinates of the forecast to the chart's visible time window. */
export function projectBurnRate(
    latest: BurnRatePoint,
    prediction: BurnRatePrediction,
    endTime: number,
): { timestamp: number; remainingPercentage: number } {
    const timestamp = Math.min(
        endTime,
        prediction.projectedExhaustAt ?? endTime,
        prediction.resetAt ?? endTime,
    );
    const elapsedHours = Math.max(0, timestamp - latest.timestamp) / HOUR_MS;
    return {
        timestamp,
        remainingPercentage: Math.max(0, Math.min(100,
            latest.remainingPercentage - prediction.burnRatePctPerHour * elapsedHours,
        )),
    };
}
