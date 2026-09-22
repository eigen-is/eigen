import { join } from 'node:path';
import { Calendar } from '../lib/calendar/calendar';
import { LocalFilesystem } from '../lib/core';
import { makeTestHome, type TestHome } from './home-test-helpers';

// A filesystem that fails where a real one can: after the rename that made a write durable and after the
// unlink that made a delete durable — both before the index commit that settles the pair — or by refusing
// one write outright, the way a full disk does.
export class DyingFilesystem extends LocalFilesystem {
    dieAfterWrite = false;
    dieAfterUnlink = false;
    dieAfterMove = false;
    refuseWriteNumber = 0;
    writes = 0;

    override async moveDurable(from: string, to: string): Promise<void> {
        await super.moveDurable(from, to);
        if (this.dieAfterMove) throw new Error('the process died after the rename');
    }

    override async writeAtomic(filePath: string, data: Buffer | Uint8Array | string): Promise<void> {
        this.writes++;
        if (this.writes === this.refuseWriteNumber) throw new Error('the filesystem refused the write');
        await super.writeAtomic(filePath, data);
        if (this.dieAfterWrite) throw new Error('the process died after the rename');
    }

    override async unlinkDurable(filePath: string): Promise<void> {
        await super.unlinkDurable(filePath);
        if (this.dieAfterUnlink) throw new Error('the process died after the unlink');
    }
}

// One scratch root per test run, wiped by each test file's beforeAll.
export const CALENDAR_TEST_ROOT = join(import.meta.dir, `../../../../data-test/test-calendar-${Date.now()}`);

// Isolated Calendar instance over a temp home dir — see home-test-helpers.ts for the stub Home under it, and
// `reopen()` on the harness for the restart simulation. `storageOf` is how a fault-injection suite hands the
// instance a filesystem that dies where a real one would: the public field is assigned before `init`, which
// is the first call to touch it.
export function makeCalendar(storageOf?: (homeDir: string) => LocalFilesystem): Promise<TestHome<Calendar>> {
    return makeTestHome((home) => {
        const calendar = new Calendar(home);
        if (storageOf) calendar.storage = storageOf(home.homeDir);
        return calendar;
    }, CALENDAR_TEST_ROOT);
}

// Where a harness home keeps its calendar directories — one spelling of the layout for every calendar test
// that reaches past the API and inspects the files on disk.
export const calendarsDirOf = (dir: string) => join(dir, 'eigen.calendar', 'calendars');
