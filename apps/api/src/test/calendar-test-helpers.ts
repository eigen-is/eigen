import { join } from 'node:path';
import { Calendar } from '../lib/calendar/calendar';
import { calendarStorage } from '../lib/calendar/resource-store';
import type { LocalFilesystem } from '../lib/core';
import { makeTestHome, type TestHome } from './home-test-helpers';

// One scratch root per test run, wiped by each test file's beforeAll.
export const CALENDAR_TEST_ROOT = join(import.meta.dir, `../../../../data-test/test-calendar-${Date.now()}`);

// Isolated Calendar instance over a temp home dir — see home-test-helpers.ts for the stub Home under it, and
// `reopen()` on the harness for the restart simulation. `storageOf` is how a fault-injection suite hands the
// instance a filesystem that dies where a real one would: the production seam is the same parameter the two
// Home classes pass their own filesystem through.
export function makeCalendar(
    storageOf: (homeDir: string) => LocalFilesystem = calendarStorage,
): Promise<TestHome<Calendar>> {
    return makeTestHome((home) => new Calendar(home, storageOf(home.homeDir)), CALENDAR_TEST_ROOT);
}

// Where a harness home keeps its calendar directories — one spelling of the layout for every calendar test
// that reaches past the API and inspects the files on disk.
export const calendarsDirOf = (dir: string) => join(dir, 'eigen.calendar', 'calendars');
