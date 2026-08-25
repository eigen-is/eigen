import { beforeAll, describe, expect, test } from 'bun:test';
import { auth } from '../../lib/auth/auth';
import { evictHome, getHome } from '../../lib/home/get-home';
import { getTestContext } from '../setup';

// Regression tests for the Home teardown race (AUDIT 2d): getHome must not open a replacement Home on
// the same DB files while the outgoing home's destruct() is still checkpointing + unlinking journals.
// It now awaits shutdown() (as evictHome does) before installing the replacement, and destruct() runs
// its teardown once so the idle timer and an explicit shutdown() can't close the DBs twice.
describe('getHome teardown race', () => {
    beforeAll(async () => {
        await getTestContext();
    });

    async function createHomeUser(email: string): Promise<string> {
        const signUp = await auth.api.signUpEmail({ body: { email, password: 'testpassword123', name: email } });
        return signUp.user.id;
    }

    test('awaits the outgoing home shutdown() before producing a replacement', async () => {
        const userId = await createHomeUser('race-order@test.eigen.is');
        const home1 = await getHome(userId);

        // Spy on the ordering instead of forcing a real teardown (which would race the mount's own
        // init-time prune timer and add flaky disk-I/O noise): stub the signal getHome branches on
        // (destructing) and gate the call it must await (shutdown), then prove it parks on that call.
        Object.defineProperty(home1, 'destructing', { configurable: true, get: () => true });
        let releaseShutdown!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseShutdown = resolve;
        });
        let shutdownResolved = false;
        const origShutdown = home1.shutdown.bind(home1);
        home1.shutdown = async () => {
            await gate;
            shutdownResolved = true;
        };

        let replacementResolved = false;
        const getPromise = getHome(userId).then((home) => {
            replacementResolved = true;
            return home;
        });

        // Flush the event loop; the gate — not this delay — is what keeps getHome parked.
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(shutdownResolved).toBe(false);
        // The fix: getHome must NOT have installed/returned a replacement while shutdown() is pending.
        expect(replacementResolved).toBe(false);

        releaseShutdown();
        const home2 = await getPromise;

        expect(shutdownResolved).toBe(true); // shutdown() completed before the replacement was produced
        expect(replacementResolved).toBe(true);
        expect(home2).not.toBe(home1);

        await evictHome(userId); // close the real replacement
        await origShutdown(); // close home1, whose real teardown the spy skipped
    });

    test('destruct() runs teardown once under concurrent shutdown() calls', async () => {
        const userId = await createHomeUser('race-idempotent@test.eigen.is');
        const home = await getHome(userId);

        let contactsDestructCalls = 0;
        const origContactsDestruct = home.contacts.destruct.bind(home.contacts);
        home.contacts.destruct = async () => {
            contactsDestructCalls++;
            return origContactsDestruct();
        };

        await Promise.all([home.shutdown(), home.shutdown(), home.shutdown()]);
        expect(contactsDestructCalls).toBe(1);

        await evictHome(userId);
    });
});
