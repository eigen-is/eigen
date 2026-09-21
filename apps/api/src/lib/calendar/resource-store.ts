import type { CalendarItem } from '@workspace/lib/types/calendar';
import {
    isSafePathSegment,
    LocalFilesystem,
    PATHS,
    type ResourceScan,
    sanitizeResourceUri,
    statResourceDir,
} from '../core';
import type * as schema from './schema';

// The calendar-shaped half of the store over `core/indexed-file-store.ts`: where a resource lives, what its
// name may be, and how large it may get. The protocol layers import these from here, never the reverse.

const ICS_SUFFIX = '.ics';

// How large one calendar resource may be, the domain's own ceiling as CARD_MAX_BYTES is contacts'. CalDAV
// bounds a PUT body against it before buffering and advertises it as C:max-resource-size.
export const EVENT_MAX_BYTES = 5_242_880;

export function calendarStorage(homeDir: string): LocalFilesystem {
    return new LocalFilesystem(`${homeDir}/${PATHS.CALENDAR.ROOT}`);
}

export function calendarDir(calendarId: string): string {
    return `${PATHS.CALENDAR.CALENDARS}/${calendarId}`;
}

export function resourcePath(calendarId: string, uri: string): string {
    return `${calendarDir(calendarId)}/${uri}`;
}

// A client-chosen calendar id is a directory name and goes raw into an href, so it takes the shared segment
// rule over the NFC form. Null on reject.
export function sanitizeCalendarId(raw: string): string | null {
    const id = raw.normalize('NFC');
    return isSafePathSegment(id) ? id : null;
}

export function sanitizeEventUri(raw: string): string | null {
    return sanitizeResourceUri(raw, ICS_SUFFIX);
}

export function statCalendarDir(storage: LocalFilesystem, calendarId: string): Promise<ResourceScan> {
    return statResourceDir(storage, calendarDir(calendarId), ICS_SUFFIX);
}

// The gate key of one resource. Neither segment holds a `/`, so the pair round-trips through one string.
export function gateKey(calendarId: string, uri: string): string {
    return `${calendarId}/${uri}`;
}

export function parseGateKey(key: string): { calendarId: string; uri: string } {
    const slash = key.indexOf('/');
    return { calendarId: key.slice(0, slash), uri: key.slice(slash + 1) };
}

// ctag advances on each change, syncGen rotates on an index rebuild so stale sync tokens are refused.
export type CalendarCollection = CalendarItem & { syncGen: number };

// The columns a (re)index computes for a resource; resourceCtag is stamped inside the write transaction.
export type ResourceRowInput = Omit<typeof schema.resources.$inferInsert, 'resourceCtag'>;

// The columns a (re)index computes for one projected VEVENT or exclusion.
export type EventRowInput = Omit<typeof schema.events.$inferInsert, 'createdAt' | 'updatedAt'> & {
    createdAt: Date;
    updatedAt: Date;
};
