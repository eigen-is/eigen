import { beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import { auth } from '../../lib/auth/auth';
import { PATHS } from '../../lib/config/paths';
import type { DatabaseConfig, SchemaType } from '../../lib/core';
import { SHARED_DB_CONFIG } from '../../lib/drive/db-config';
import { atHome, evictHome, getHome, shutdownAllHomes } from '../../lib/home/get-home';
import { createSSEStream } from '../../lib/home/sse-stream';
import { getTestContext } from '../setup';

// getHome must not open a replacement Home on the same database files while the outgoing home is
// still closing them. It awaits close() before installing the replacement, and close() runs once, so
// the idle timer and an explicit close() can't close the databases twice.
const USER_IDLE_MS = 5 * 60_000;

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

    // A database a closed home handed out would never be closed, and the next home would open the same file again.
    test('a closed home refuses to open a database', async () => {
        const userId = await createHomeUser('closed-refuses-db@test.eigen.is');
        const home = await getHome(userId);

        await home.close();
        await expect(home.getLocalDatabase(SHARED_DB_CONFIG, PATHS.DRIVE.SHARED_DB)).rejects.toThrow('Home is closing');
    });

    // The close takes its list of databases to close part way through, so one opened meanwhile could be missed.
    test('a home that is closing refuses to open a database', async () => {
        const userId = await createHomeUser('closing-refuses-db@test.eigen.is');
        const home = await getHome(userId);

        const closing = home.close();
        await expect(home.getLocalDatabase(SHARED_DB_CONFIG, 'probe.db')).rejects.toThrow('Home is closing');
        await closing;
    });

    test('an owner whose home fails to build is not left in the cache', async () => {
        const ownerId = 'abcdefghijklmnopqrstuvwxyz012345';
        await expect(getHome(ownerId)).rejects.toThrow('User not found');
        expect(atHome(ownerId)).toBe(false);
    });

    // A hold taken now would never hear the close, and its holder would keep a closed home's parts.
    test('a closing home refuses a hold', async () => {
        const userId = await createHomeUser('closing-refuses-hold@test.eigen.is');
        const home = await getHome(userId);

        const closing = home.close();
        let refusal: unknown;
        try {
            home.hold();
        } catch (err) {
            refusal = err;
        }
        expect(refusal).toMatchObject({ status: 503, message: 'Home is closing' });
        await closing;
    });

    // An event stream ends from here, so its tab reconnects to the next home before this one's databases close.
    test('a hold hears the close before the parts close, and a released hold never does', async () => {
        const userId = await createHomeUser('hold-hears-close@test.eigen.is');
        const home = await getHome(userId);
        const destruct = spyOn(home.drive, 'destruct');
        const heard: string[] = [];

        home.hold(() => heard.push(`held, parts closed: ${destruct.mock.calls.length}`));
        const release = home.hold(() => heard.push('released'));
        release();
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        // One holder that throws must not stop the close or the holders after it.
        home.hold(() => {
            throw new Error('holder failed');
        });
        home.hold(() => heard.push('after the failure'));

        await home.close();
        errors.mockRestore();
        expect(heard).toEqual(['held, parts closed: 0', 'after the failure']);
        expect(atHome(userId)).toBe(false);
    });

    // A database that failed to open has nothing to close, so the close must not open it again. The next
    // call that asks for it does try again.
    test('a database whose open failed opens again on the next call, and the close skips it', async () => {
        const userId = await createHomeUser('close-skips-failed-db@test.eigen.is');
        const home = await getHome(userId);
        let opens = 0;
        const broken: DatabaseConfig<SchemaType> = {
            name: 'broken-probe',
            currentVersion: 1,
            schema: {},
            migrations: [
                {
                    version: 1,
                    up: () => {
                        opens++;
                        throw new Error('broken migration');
                    },
                },
            ],
        };
        await expect(home.getLocalDatabase(broken, 'broken-probe.db')).rejects.toThrow('broken migration');
        await expect(home.getLocalDatabase(broken, 'broken-probe.db')).rejects.toThrow('broken migration');
        expect(opens).toBe(2);
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        try {
            await home.close();
            expect(opens).toBe(2);
            expect(errors.mock.calls.some(([line]) => String(line).includes('broken-probe.db'))).toBe(false);
        } finally {
            errors.mockRestore();
        }
    });

    // A long request, such as an upload, holds its home while it runs and lets go however it ends.
    test('withHomeHeld keeps the home open past its idle, and lets go when the work throws', async () => {
        const userId = await createHomeUser('with-home-held@test.eigen.is');
        const home = await getHome(userId);
        let closingMidWork: boolean | undefined;
        jest.useFakeTimers();
        try {
            home.touch();
            const work = home.withHomeHeld(async () => {
                jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
                closingMidWork = home.closing;
                throw new Error('work failed');
            });
            await expect(work).rejects.toThrow('work failed');
            expect(closingMidWork).toBe(false);
            jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
            expect(home.closing).toBe(true);
        } finally {
            jest.useRealTimers();
        }
        await home.close();
    });

    // The process ends once the shutdown is done, so a Home built during it would be killed half-open.
    test('no Home opens while shutdownAllHomes runs, and an open stream ends with its Home', async () => {
        const userId = await createHomeUser('shutdown-gate@test.eigen.is');
        const home = await getHome(userId);
        const reader = createSSEStream(home).getReader();
        // Holds the shutdown open until the check below is done.
        const { promise: held, resolve: release } = Promise.withResolvers<void>();
        const close = home.close.bind(home);
        home.close = async () => {
            await held;
            await close();
        };

        const shutdown = shutdownAllHomes();
        await expect(getHome(userId)).rejects.toMatchObject({ status: 503 });
        release();
        await shutdown;
        while (!(await reader.read()).done) {}
        expect(atHome(userId)).toBe(false);
    });
});
