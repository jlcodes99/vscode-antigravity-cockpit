import { getAccountRemainingPercentage, selectAutoSwitchTarget } from './account_auto_switch';
import { QuotaSnapshot } from '../shared/types';

describe('account auto switch helpers', () => {
    it('prefers prompt credits when computing the remaining percentage', () => {
        const snapshot = {
            timestamp: new Date(),
            promptCredits: {
                available: 10,
                monthly: 100,
                usedPercentage: 58,
                remainingPercentage: 42,
            },
            models: [
                {
                    label: 'Model A',
                    modelId: 'model-a',
                    remainingPercentage: 80,
                    isExhausted: false,
                    resetTime: new Date(),
                    timeUntilReset: 0,
                    timeUntilResetFormatted: '0m',
                    resetTimeDisplay: 'now',
                },
            ],
            isConnected: true,
        } satisfies QuotaSnapshot;

        expect(getAccountRemainingPercentage(snapshot)).toBe(42);
    });

    it('selects the healthiest eligible account above the threshold', () => {
        const target = selectAutoSwitchTarget({
            currentEmail: 'primary@example.com',
            currentRemainingPercentage: 18,
            threshold: 20,
            candidates: [
                { email: 'backup-a@example.com', remainingPercentage: 22 },
                { email: 'backup-b@example.com', remainingPercentage: 64 },
                { email: 'backup-c@example.com', remainingPercentage: 54 },
            ],
        });

        expect(target).toEqual({
            email: 'backup-b@example.com',
            remainingPercentage: 64,
        });
    });

    it('falls back to the best improvement when no account clears the threshold', () => {
        const target = selectAutoSwitchTarget({
            currentEmail: 'primary@example.com',
            currentRemainingPercentage: 14,
            threshold: 20,
            candidates: [
                { email: 'backup-a@example.com', remainingPercentage: 15 },
                { email: 'backup-b@example.com', remainingPercentage: 16 },
                { email: 'backup-c@example.com', remainingPercentage: 10 },
            ],
        });

        expect(target).toEqual({
            email: 'backup-b@example.com',
            remainingPercentage: 16,
        });
    });

    it('returns null when auto switch is disabled or no better account exists', () => {
        expect(selectAutoSwitchTarget({
            currentEmail: 'primary@example.com',
            currentRemainingPercentage: 18,
            threshold: 0,
            candidates: [
                { email: 'backup@example.com', remainingPercentage: 80 },
            ],
        })).toBeNull();

        expect(selectAutoSwitchTarget({
            currentEmail: 'primary@example.com',
            currentRemainingPercentage: 50,
            threshold: 20,
            candidates: [
                { email: 'backup@example.com', remainingPercentage: 10 },
            ],
        })).toBeNull();
    });
});
