import { QuotaSnapshot } from '../shared/types';

export interface AutoSwitchCandidate {
    email: string;
    remainingPercentage: number;
}

export interface AutoSwitchTarget {
    email: string;
    remainingPercentage: number;
}

function isFinitePercentage(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function collectRemainingPercentages(snapshot: QuotaSnapshot): number[] {
    const values: number[] = [];

    if (isFinitePercentage(snapshot.promptCredits?.remainingPercentage)) {
        values.push(snapshot.promptCredits!.remainingPercentage);
    }

    const models = snapshot.allModels?.length ? snapshot.allModels : snapshot.models;
    for (const model of models || []) {
        if (isFinitePercentage(model.remainingPercentage)) {
            values.push(model.remainingPercentage);
        }
    }

    for (const group of snapshot.groups || []) {
        if (isFinitePercentage(group.remainingPercentage)) {
            values.push(group.remainingPercentage);
        }
    }

    return values;
}

/**
 * Returns the lowest usable remaining quota percentage for an account snapshot.
 * Uses prompt credits, model pools, and group pools when they are available.
 */
export function getAccountRemainingPercentage(snapshot?: QuotaSnapshot | null): number | null {
    if (!snapshot) {
        return null;
    }

    const values = collectRemainingPercentages(snapshot).filter(value => value >= 0 && value <= 100);
    if (values.length === 0) {
        return null;
    }

    return Math.min(...values);
}

function compareTarget(left: AutoSwitchCandidate, right: AutoSwitchCandidate): number {
    if (left.remainingPercentage !== right.remainingPercentage) {
        return right.remainingPercentage - left.remainingPercentage;
    }
    return left.email.localeCompare(right.email);
}

export function selectAutoSwitchTarget(params: {
    currentEmail: string;
    currentRemainingPercentage: number;
    threshold: number;
    candidates: AutoSwitchCandidate[];
}): AutoSwitchTarget | null {
    const currentThreshold = Math.floor(params.threshold);
    if (!Number.isFinite(currentThreshold) || currentThreshold <= 0) {
        return null;
    }

    const currentRemaining = params.currentRemainingPercentage;
    if (!Number.isFinite(currentRemaining) || currentRemaining >= currentThreshold) {
        return null;
    }

    const currentEmail = params.currentEmail.trim().toLowerCase();
    const eligibleCandidates = params.candidates.filter(candidate => {
        const email = candidate.email.trim().toLowerCase();
        return email !== currentEmail
            && isFinitePercentage(candidate.remainingPercentage)
            && candidate.remainingPercentage > 0;
    });

    if (eligibleCandidates.length === 0) {
        return null;
    }

    const healthyCandidates = eligibleCandidates
        .filter(candidate => candidate.remainingPercentage >= currentThreshold)
        .sort(compareTarget);

    const selected = healthyCandidates.length > 0
        ? healthyCandidates[0]
        : eligibleCandidates
            .filter(candidate => candidate.remainingPercentage > currentRemaining)
            .sort(compareTarget)[0];

    if (!selected) {
        return null;
    }

    return {
        email: selected.email,
        remainingPercentage: selected.remainingPercentage,
    };
}
