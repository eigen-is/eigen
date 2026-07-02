import { describe, expect, test } from 'bun:test';
import type { Drive } from '../lib/drive';
import { Home } from '../lib/home/home';
import type Maildir from '../lib/mail/maildir';
import type { User } from '../lib/user';

// AUDIT 13: Home.init() opens subsystem DBs + starts upload/reindex timers in parallel. If one
// subsystem's init() throws, the peers that already initialised must be torn down — otherwise their
// open fds + live intervals leak for the process lifetime. This drives that path with fakes: mail's
// init() throws while drive's init() is held open by a gate, and asserts drive.destruct() ran — but
// only AFTER drive.init() finished (the allSettled-before-teardown invariant: a regression back to
// Promise.all would tear down while the peer is still mid-init).
class LeakProbeHome extends Home {
    driveInitCompleted = false;
    driveInitCompletedWhenDestructRan: boolean | undefined;

    constructor(driveInitGate: Promise<void>) {
        super({ id: 'leak-probe' } as User);

        this._drive = {
            init: async () => {
                await driveInitGate;
                this.driveInitCompleted = true;
            },
            destruct: async () => {
                this.driveInitCompletedWhenDestructRan = this.driveInitCompleted;
            },
        } as unknown as Drive;

        this._mail = {
            init: async () => {
                throw new Error('mail boom');
            },
            destruct: async () => {},
        } as unknown as Maildir;
    }
}

describe('Home.init partial-failure teardown (AUDIT 13)', () => {
    test('a subsystem init failure tears down the already-initialised peers, after they all finished', async () => {
        let releaseDriveInit!: () => void;
        const home = new LeakProbeHome(
            new Promise((resolve) => {
                releaseDriveInit = resolve;
            }),
        );

        const initPromise = home.init();
        // Flush the queue so mail's rejection has propagated while drive.init is still gated — a
        // Promise.all regression would run teardown here, mid-init, recording driveInitCompleted=false.
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseDriveInit();

        await expect(initPromise).rejects.toThrow('mail boom');
        expect(home.driveInitCompletedWhenDestructRan).toBe(true);
    });

    test('concurrent init() callers queued during a failing init are rejected, not left hanging', async () => {
        let releaseDriveInit!: () => void;
        const home = new LeakProbeHome(
            new Promise((resolve) => {
                releaseDriveInit = resolve;
            }),
        );

        const first = home.init(); // marks initialization started before its first await
        // Observe settledness instead of awaiting `queued` — a regression that leaves the waiter
        // pending forever should fail this test fast, not hang the suite.
        let queuedError: Error | undefined;
        home.init().catch((e: Error) => {
            queuedError = e;
        });
        releaseDriveInit();

        await expect(first).rejects.toThrow('mail boom');
        // The failure path rejects waiters before rethrowing, so by now the queued call has settled.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(queuedError?.message).toBe('mail boom');
    });
});
