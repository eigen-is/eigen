import { join } from 'node:path';
import { Calendar } from '../lib/calendar/calendar';
import { makeTestHome, type TestHome } from './home-test-helpers';

// One scratch root per test run, wiped by each test file's beforeAll.
export const CALENDAR_TEST_ROOT = join(import.meta.dir, `../../../../data-test/test-calendar-${Date.now()}`);

// Isolated Calendar instance over a temp home dir — see home-test-helpers.ts for the stub Home under it, and
// `reopen()` on the harness for the restart simulation.
export function makeCalendar(): Promise<TestHome<Calendar>> {
    return makeTestHome((home) => new Calendar(home), CALENDAR_TEST_ROOT);
}

// The stored bytes of a resource, which are the truth every calendar assertion reads.
export async function resourceTextOf(calendar: Calendar, calendarId: string, uri: string): Promise<string> {
    const resource = await calendar.getResource(calendarId, uri);
    if (!resource) throw new Error(`no resource stored at ${calendarId}/${uri}`);
    return new TextDecoder().decode(resource.bytes);
}
