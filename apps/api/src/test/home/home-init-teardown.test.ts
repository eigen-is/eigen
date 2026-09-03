import { describe, expect, test } from 'bun:test';
import type { JsonStore } from '../../lib/core';
import type { Drive } from '../../lib/drive';
import { Home, type HomeSettings } from '../../lib/home/home';
import type { Mail } from '../../lib/mail/mail-domain';
import type { User } from '../../lib/user';

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
        } as unknown as Mail;
    }
}

// P2 batch review: settings.load() runs BEFORE the subsystem allSettled block — its throw must take
// the same failure path (shutdown + waiter rejection) instead of stranding queued init() callers.
class CorruptSettingsHome extends Home {
    driveDestructRan = false;

    constructor() {
        super({ id: 'corrupt-settings-probe' } as User);

        this.settings = {
            load: async () => {
                throw new Error('settings corrupt');
            },
        } as unknown as JsonStore<HomeSettings>;

        this._drive = {
            init: async () => {},
            destruct: async () => {
                this.driveDestructRan = true;
            },
        } as unknown as Drive;
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

    test('a second init() after a failed one re-rejects instead of hanging', async () => {
        const home = new LeakProbeHome(Promise.resolve());

        await expect(home.init()).rejects.toThrow('mail boom');
        await expect(home.init()).rejects.toThrow('mail boom');
    });

    test('a settings.load() failure rejects queued init() callers and tears the instance down', async () => {
        const home = new CorruptSettingsHome();

        const first = home.init(); // marks initialization started before its first await
        // Observe settledness instead of awaiting `queued` — a regression that leaves the waiter
        // pending forever should fail this test fast, not hang the suite.
        let queuedError: Error | undefined;
        home.init().catch((e: Error) => {
            queuedError = e;
        });

        await expect(first).rejects.toThrow('settings corrupt');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(queuedError?.message).toBe('settings corrupt');
        expect(home.driveDestructRan).toBe(true);
    });
});
