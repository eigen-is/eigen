import { beforeAll, describe, expect, test } from 'bun:test';
import { auth } from '../../lib/auth/auth';
import { atHome, evictHome, getHome } from '../../lib/home/get-home';
import { getTestContext } from '../setup';

// getHome must not open a replacement Home on the same database files while the outgoing home is
// still closing them. It awaits close() before installing the replacement, and close() runs once, so
// the idle timer and an explicit close() can't close the databases twice.
describe('getHome teardown race', () => {
    beforeAll(async () => {
        await getTestContext();
    });

    async function createHomeUser(email: string): Promise<string> {
        const signUp = await auth.api.signUpEmail({ body: { email, password: 'testpassword123', name: email } });
        return signUp.user.id;
    }

    test('awaits the outgoing home close() before producing a replacement', async () => {
        const userId = await createHomeUser('race-order@test.eigen.is');
        const home1 = await getHome(userId);

        // Gate the ordering: stub the signal getHome branches on (closing) and hold the call it
        // must await (close) behind a gate, then prove it parks on that call. The gated close
        // runs the REAL teardown once released, so home1's DB handles are closed before getHome opens
        // the replacement — the same non-overlap production relies on. Skipping the real teardown here
        // would leave home1's connections open alongside home2's on the same files.
        Object.defineProperty(home1, 'closing', { configurable: true, get: () => true });
        let releaseClose!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseClose = resolve;
        });
        let closeResolved = false;
        const origClose = home1.close.bind(home1);
        home1.close = async () => {
            await gate;
            await origClose();
            closeResolved = true;
        };

        let replacementResolved = false;
        const getPromise = getHome(userId).then((home) => {
            replacementResolved = true;
            return home;
        });

        // Flush the event loop; the gate — not this delay — is what keeps getHome parked.
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(closeResolved).toBe(false);
        // The fix: getHome must NOT have installed/returned a replacement while close() is pending.
        expect(replacementResolved).toBe(false);

        releaseClose();
        const home2 = await getPromise;

        expect(closeResolved).toBe(true); // close() completed before the replacement was produced
        expect(replacementResolved).toBe(true);
        expect(home2).not.toBe(home1);

        await evictHome(userId); // close the real replacement; home1 was already closed
    });

    test('close() runs once under concurrent calls', async () => {
        const userId = await createHomeUser('race-idempotent@test.eigen.is');
        const home = await getHome(userId);

        let contactsDestructCalls = 0;
        const origContactsDestruct = home.contacts.destruct.bind(home.contacts);
        home.contacts.destruct = async () => {
            contactsDestructCalls++;
            return origContactsDestruct();
        };

        await Promise.all([home.close(), home.close(), home.close()]);
        expect(contactsDestructCalls).toBe(1);

        await evictHome(userId);
    });

    test('a home that closes leaves the cache, and the next getHome builds a new one', async () => {
        const userId = await createHomeUser('closed-leaves-cache@test.eigen.is');
        const home = await getHome(userId);

        await home.close();
        expect(atHome(userId)).toBe(false);

        const next = await getHome(userId);
        expect(next).not.toBe(home);
        await evictHome(userId);
    });

    test('an owner whose home fails to build is not left in the cache', async () => {
        const ownerId = 'abcdefghijklmnopqrstuvwxyz012345';
        await expect(getHome(ownerId)).rejects.toThrow('User not found');
        expect(atHome(ownerId)).toBe(false);
    });
});
