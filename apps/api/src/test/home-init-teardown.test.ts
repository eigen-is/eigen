import { describe, expect, test } from 'bun:test';
import type { Drive } from '../lib/drive';
import { Home } from '../lib/home/home';
import type Maildir from '../lib/mail/maildir';
import type { User } from '../lib/user';

// AUDIT 13: Home.init() opens subsystem DBs + starts upload/reindex timers in parallel. If one
// subsystem's init() throws, the peers that already initialised must be torn down — otherwise their
// open fds + live intervals leak for the process lifetime. This drives that path with fakes: mail's
// init() throws after drive's init() has "opened", and asserts drive.destruct() ran.
class LeakProbeHome extends Home {
    constructor(private readonly onDriveDestruct: () => void) {
        super({ id: 'leak-probe' } as User);

        this._drive = {
            init: async () => {},
            destruct: async () => this.onDriveDestruct(),
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
    test('a subsystem init failure tears down the already-initialised peers', async () => {
        let driveDestructed = false;
        const home = new LeakProbeHome(() => {
            driveDestructed = true;
        });

        await expect(home.init()).rejects.toThrow('mail boom');
        expect(driveDestructed).toBe(true);
    });
});
