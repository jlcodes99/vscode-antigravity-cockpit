import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { QuotaSnapshot } from '../shared/types';
import { logger } from '../shared/log_service';
import { writePrivateFileAtomic } from '../shared/secure_fs';
import { predictBurnRate, type BurnRatePrediction } from './burn_rate';

export interface QuotaHistoryPoint {
    timestamp: number;
    remainingPercentage: number;
    resetTime?: number;
    countdownSeconds?: number;
    isStart?: boolean;
    isReset?: boolean;
}

export interface QuotaHistoryModelRecord {
    modelId: string;
    label: string;
    points: QuotaHistoryPoint[];
    hasCountdownDropAt100?: boolean;
}

export interface QuotaHistoryRecord {
    email: string;
    updatedAt: number;
    models: Record<string, QuotaHistoryModelRecord>;
}

export interface QuotaHistoryModelOption {
    modelId: string;
    label: string;
}

export interface QuotaHistoryResult {
    email: string;
    rangeDays: number;
    modelId: string | null;
    models: QuotaHistoryModelOption[];
    points: QuotaHistoryPoint[];
    prediction: BurnRatePrediction | null;
}

const HISTORY_DAYS_LIMIT = 30;
const HISTORY_MAX_POINTS_PER_MODEL = 5000;
const HISTORY_ROOT = path.join(os.homedir(), '.antigravity_cockpit', 'cache', 'quota_history');

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function isValidEmail(email?: string | null): email is string {
    return typeof email === 'string' && email.includes('@');
}

function hashEmail(email: string): string {
    return createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function getHistoryFilePath(email: string): string {
    return path.join(HISTORY_ROOT, `${hashEmail(email)}.json`);
}

function normalizeRangeDays(rangeDays?: number): number {
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

function normalizeCountdownSeconds(value: Date | undefined, now: number): number | undefined {
    if (!value) {
        return undefined;
    }
    const ms = value.getTime() - now;
    if (!Number.isFinite(ms)) {
        return undefined;
    }
    return Math.max(0, Math.round(ms / 1000));
}

function getCountdownDisplayMinutes(seconds?: number): number | null {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
        return null;
    }
    if (seconds <= 0) {
        return 0;
    }
    return Math.ceil(seconds / 60);
}

function extractSnapshotQuotaSeries(
    snapshot: QuotaSnapshot,
    now: number,
): Array<{
    groupId: string;
    label: string;
    remainingPercentage: number;
    resetTime?: number;
    countdownSeconds?: number;
}> {
    const groups: Array<{
        groupId: string;
        label: string;
        remainingPercentage: number;
        resetTime?: number;
        countdownSeconds?: number;
    }> = [];

    if (snapshot.groups && snapshot.groups.length > 0) {
        for (const group of snapshot.groups) {
            const windows = group.quotaWindows && group.quotaWindows.length > 0
                ? group.quotaWindows
                : [{
                    windowId: 'model-quota',
                    windowName: 'Model Quota',
                    remainingPercentage: group.remainingPercentage,
                    resetTime: group.resetTime,
                }];

            for (const window of windows) {
                if (!Number.isFinite(window.remainingPercentage)) {
                    continue;
                }
                const resetTimeMs = window.resetTime?.getTime();
                const groupLabel = windows.length > 1
                    ? `${group.groupName} / ${window.windowName}`
                    : group.groupName;
                const label = window.windowId === 'gemini-argon-wtu-weekly' ? window.windowName : groupLabel;
                groups.push({
                    groupId: `${group.groupId}:${window.windowId}`,
                    label,
                    remainingPercentage: window.remainingPercentage,
                    resetTime: Number.isFinite(resetTimeMs) ? resetTimeMs : undefined,
                    countdownSeconds: normalizeCountdownSeconds(window.resetTime, now),
                });
            }
        }
        return groups;
    }

    for (const model of snapshot.models) {
        if (!Number.isFinite(model.remainingPercentage)) {
            continue;
        }
        const resetTimeMs = model.resetTime?.getTime();
        groups.push({
            groupId: model.modelId,
            label: model.label,
            remainingPercentage: model.remainingPercentage ?? 0,
            resetTime: Number.isFinite(resetTimeMs) ? resetTimeMs : undefined,
            countdownSeconds: normalizeCountdownSeconds(model.resetTime, now),
        });
    }

    return groups;
}

type PointAction = 'add' | 'overwrite' | 'skip';

function resolvePointAction(
    last: QuotaHistoryPoint | undefined,
    next: QuotaHistoryPoint,
    record: QuotaHistoryModelRecord,
): { action: PointAction; isStart?: boolean; isReset?: boolean } {
    if (!last) {
        return { action: 'add' };
    }
    const lastPct = last.remainingPercentage;
    const nextPct = next.remainingPercentage;

    if (last.resetTime && last.resetTime <= next.timestamp && next.resetTime && next.resetTime > next.timestamp) {
        record.hasCountdownDropAt100 = false;
        return { action: 'add', isReset: true };
    }

    if (nextPct < 100) {
        record.hasCountdownDropAt100 = false;
        if (lastPct === 100 && nextPct < 100) {
            return { action: 'add', isStart: true };
        }
        if (lastPct === nextPct) {
            // Keep idle periods in the regression instead of assuming continued consumption.
            return { action: next.timestamp - last.timestamp >= 10 * 60 * 1000 ? 'add' : 'skip' };
        }
        if (nextPct > lastPct) {
            return { action: 'add', isReset: true };
        }
        return { action: 'add' };
    }

    if (lastPct < 100) {
        record.hasCountdownDropAt100 = false;
        return { action: 'add', isReset: true };
    }

    const lastDisplay = getCountdownDisplayMinutes(last.countdownSeconds);
    const nextDisplay = getCountdownDisplayMinutes(next.countdownSeconds);
    if (lastDisplay === null || nextDisplay === null) {
        return { action: 'overwrite' };
    }

    const delta = nextDisplay - lastDisplay;
    if (delta > 1) {
        record.hasCountdownDropAt100 = false;
        return { action: 'add', isReset: true };
    }
    if (delta < -2) {
        if (record.hasCountdownDropAt100) {
            return { action: 'overwrite' };
        }
        record.hasCountdownDropAt100 = true;
        return { action: 'add', isStart: true };
    }
    return { action: 'overwrite' };
}

function trimPoints(points: QuotaHistoryPoint[], now: number): QuotaHistoryPoint[] {
    const cutoff = now - HISTORY_DAYS_LIMIT * 24 * 60 * 60 * 1000;
    const filtered = points.filter(point => point.timestamp >= cutoff);
    if (filtered.length <= HISTORY_MAX_POINTS_PER_MODEL) {
        return filtered;
    }
    return filtered.slice(filtered.length - HISTORY_MAX_POINTS_PER_MODEL);
}

async function readHistory(email: string): Promise<QuotaHistoryRecord | null> {
    try {
        const content = await fs.readFile(getHistoryFilePath(email), 'utf8');
        const parsed = JSON.parse(content) as QuotaHistoryRecord;
        if (!parsed || !parsed.models || typeof parsed.models !== 'object') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

async function writeHistory(record: QuotaHistoryRecord): Promise<void> {
    await writePrivateFileAtomic(getHistoryFilePath(record.email), JSON.stringify(record, null, 2));
}

export async function clearHistory(email: string): Promise<boolean> {
    try {
        const filePath = getHistoryFilePath(email);
        await fs.unlink(filePath);
        return true;
    } catch {
        return false;
    }
}

export async function clearAllHistory(): Promise<boolean> {
    try {
        await fs.mkdir(HISTORY_ROOT, { recursive: true });
        const files = await fs.readdir(HISTORY_ROOT);
        await Promise.all(
            files
                .filter(file => file.endsWith('.json'))
                .map(file => fs.unlink(path.join(HISTORY_ROOT, file))),
        );
        return true;
    } catch {
        return false;
    }
}

function buildModelOptions(record: QuotaHistoryRecord): QuotaHistoryModelOption[] {
    return Object.values(record.models || {})
        .map(model => ({
            modelId: model.modelId,
            label: model.label || model.modelId,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

export async function recordQuotaHistory(email: string | null | undefined, snapshot: QuotaSnapshot): Promise<boolean> {
    if (!snapshot.isConnected) {
        return false;
    }
    if (!isValidEmail(email)) {
        return false;
    }

    const now = Date.now();
    const groups = extractSnapshotQuotaSeries(snapshot, now);
    if (groups.length === 0) {
        return false;
    }

    try {
        const normalizedEmail = normalizeEmail(email);
        const existing = await readHistory(normalizedEmail);
        const record: QuotaHistoryRecord = existing ?? {
            email: normalizedEmail,
            updatedAt: now,
            models: {},
        };

        let changed = false;

        for (const group of groups) {
            const modelRecord = record.models[group.groupId] ?? {
                modelId: group.groupId,
                label: group.label,
                points: [],
            };

            if (!record.models[group.groupId]) {
                record.models[group.groupId] = modelRecord;
                changed = true;
            }

            if (modelRecord.label !== group.label) {
                modelRecord.label = group.label;
                changed = true;
            }

            const nextPoint: QuotaHistoryPoint = {
                timestamp: now,
                remainingPercentage: group.remainingPercentage,
                resetTime: group.resetTime,
                countdownSeconds: group.countdownSeconds,
            };

            const lastPoint = modelRecord.points[modelRecord.points.length - 1];
            const decision = resolvePointAction(lastPoint, nextPoint, modelRecord);
            if (decision.action === 'skip') {
                continue;
            }
            if (decision.isStart) {
                nextPoint.isStart = true;
            }
            if (decision.isReset) {
                nextPoint.isReset = true;
            }
            if (decision.action === 'overwrite' && modelRecord.points.length > 0) {
                if (lastPoint?.isStart) {
                    nextPoint.isStart = true;
                }
                if (lastPoint?.isReset) {
                    nextPoint.isReset = true;
                }
                modelRecord.points[modelRecord.points.length - 1] = nextPoint;
            } else {
                modelRecord.points.push(nextPoint);
            }

            modelRecord.points = trimPoints(modelRecord.points, now);
            changed = true;
        }

        if (!changed) {
            return false;
        }

        record.updatedAt = now;
        await writeHistory(record);
        return true;
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.debug(`[QuotaHistory] Failed to record history for ${email}: ${err.message}`);
        return false;
    }
}

export async function getQuotaHistory(
    email: string | null | undefined,
    rangeDays?: number,
    modelId?: string,
): Promise<QuotaHistoryResult | null> {
    if (!isValidEmail(email)) {
        return null;
    }
    const normalizedEmail = normalizeEmail(email);
    const normalizedRange = normalizeRangeDays(rangeDays);
    const record = await readHistory(normalizedEmail);

    if (!record) {
        return {
            email: normalizedEmail,
            rangeDays: normalizedRange,
            modelId: null,
            models: [],
            points: [],
            prediction: null,
        };
    }

    const models = buildModelOptions(record);
    const availableModelIds = new Set(models.map(model => model.modelId));
    const selectedModelId = modelId && availableModelIds.has(modelId)
        ? modelId
        : (models[0]?.modelId ?? null);

    let points: QuotaHistoryPoint[] = [];
    if (selectedModelId && record.models[selectedModelId]) {
        const now = Date.now();
        const cutoff = now - normalizedRange * 24 * 60 * 60 * 1000;
        points = record.models[selectedModelId].points
            .filter(point => point.timestamp >= cutoff)
            .sort((a, b) => a.timestamp - b.timestamp);
    }

    const fullPoints = selectedModelId ? record.models[selectedModelId]?.points ?? [] : [];
    const predictionResult = predictBurnRate(fullPoints);
    const prediction = predictionResult.projectedExhaustAt ? predictionResult : null;

    return {
        email: normalizedEmail,
        rangeDays: normalizedRange,
        modelId: selectedModelId,
        models,
        points,
        prediction,
    };
}
