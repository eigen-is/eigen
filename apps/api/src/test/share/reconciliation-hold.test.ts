import { afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import { evictHome, getHome } from '../../lib/home/get-home';
import * as relay from '../../lib/home/home-relay';
import { reconcileSharesForNewUser } from '../../lib/share';
import { addRegistryEntry } from '../../lib/share/registry';
import { getUserById } from '../../lib/user';
import { createTestUser, getTestContext } from '../setup';

const USER_IDLE_MS = 5 * 60_000;

// Reconciliation waits on pulls from other homes, so it holds the newcomer's home for as long as it runs.
describe('reconcileSharesForNewUser', () => {
    const spies: { mockRestore(): void }[] = [];

    beforeAll(async () => {
        await getTestContext();
    });

    afterEach(() => {
        jest.useRealTimers();
        for (const spy of spies.splice(0)) spy.mockRestore();
    });

    test('holds the target home while a pull is pending, past its idle', async () => {
        const stamp = Date.now();
        const owner = await createTestUser(`recon-owner-${stamp}@test.eigen.is`, 'testpassword123', 'Owner');
        const created = await createTestUser(`recon-new-${stamp}@test.eigen.is`, 'testpassword123', 'Newcomer');
        const user = await getUserById(created.id);
        if (!user) throw new Error('newcomer missing');
        await addRegistryEntry(owner.id, user.email);
        const home = await getHome(user.id);

        let openGate: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            openGate = resolve;
        });
        let reached: () => void = () => {};
        const pulling = new Promise<void>((resolve) => {
            reached = resolve;
        });
        spies.push(
            spyOn(relay, 'pullCalendarShares').mockResolvedValue([]),
            spyOn(relay, 'pullPendingInvitations').mockResolvedValue([]),
            spyOn(relay, 'pullSharedPaths').mockImplementation(async () => {
                reached();
                await gate;
                return [];
            }),
        );

        jest.useFakeTimers();
        const running = reconcileSharesForNewUser(user);
        await pulling;
        jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
        expect(home.closing).toBe(false);

        openGate();
        await running;
        jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
        expect(home.closing).toBe(true);
        jest.useRealTimers();
        await evictHome(user.id);
    });
});
