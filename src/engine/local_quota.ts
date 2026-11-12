import { ModelQuotaInfo, QuotaSnapshot } from '../shared/types';
import { AUTH_MODEL_BLACKLIST_IDS } from '../shared/recommended_models';

const excludedIds = new Set([...AUTH_MODEL_BLACKLIST_IDS, 'unknown', '']);

export function collapseLocalQuotaVariants(models: ModelQuotaInfo[], pinnedModels: string[]): ModelQuotaInfo[] {
    const pinned = new Set(pinnedModels.map(model => model.toLowerCase()));
    const isPinned = (model: ModelQuotaInfo) => pinned.has(model.modelId.toLowerCase()) || pinned.has(model.label.toLowerCase());
    const rows = [...models];
    const buckets = new Map<string, { index: number; hasDuplicates: boolean }>();
    const duplicates = new Set<number>();
    const signaturesByLabel = new Map<string, Set<string>>();

    models.forEach((model, index) => {
        const baseLabel = model.label.replace(/\s*\((?:High|Medium|Low)\)\s*$/i, '').trim();
        if (!baseLabel || baseLabel === model.label || !Number.isFinite(model.remainingPercentage) || model.resetTimeValid !== true) {
            return;
        }
        const signature = JSON.stringify([baseLabel, model.remainingPercentage, model.resetTime.getTime()]);
        const signatures = signaturesByLabel.get(baseLabel) ?? new Set<string>();
        signatures.add(signature);
        signaturesByLabel.set(baseLabel, signatures);
        const bucket = buckets.get(signature);
        if (!bucket) {
            buckets.set(signature, { index, hasDuplicates: false });
            return;
        }
        bucket.hasDuplicates = true;
        duplicates.add(index);
        if (isPinned(model) && !isPinned(rows[bucket.index])) {
            rows[bucket.index] = model;
        }
    });

    for (const [baseLabel, signatures] of signaturesByLabel) {
        const bucket = signatures.size === 1 ? buckets.get([...signatures][0]) : undefined;
        if (bucket?.hasDuplicates) {
            rows[bucket.index] = { ...rows[bucket.index], label: baseLabel };
        }
    }
    return rows.filter((_, index) => !duplicates.has(index));
}

/** Missing identity is not evidence that two accounts match. */
export function matchLocalAccount(
    snapshot: QuotaSnapshot | null | undefined,
    targetEmail?: string | null,
): QuotaSnapshot | null {
    const localEmail = snapshot?.userInfo?.email?.trim().toLowerCase();
    const target = targetEmail?.trim().toLowerCase();
    return snapshot?.isConnected && localEmail?.includes('@') && localEmail === target
        ? snapshot
        : null;
}

export function mergeAuthorizedModels(
    models: ModelQuotaInfo[],
    localSnapshot: QuotaSnapshot | null | undefined,
    targetEmail?: string | null,
): ModelQuotaInfo[] {
    const matched = matchLocalAccount(localSnapshot, targetEmail);
    if (!matched) {
        return models;
    }
    const existing = new Set(models.map(model => model.modelId));
    const extras = (matched.allModels ?? matched.models).filter(model => {
        if (existing.has(model.modelId) || excludedIds.has(model.modelId)) {
            return false;
        }
        existing.add(model.modelId);
        return true;
    });
    return [...models, ...extras];
}
