// One whole `.ics`, shared FE/BE: the preview guard and the import refuse a bigger file. Both parse the
// file in one pass the way a CalDAV PUT does, which is what keeps it well under the 20 MiB one CalDAV
// resource may be (caldav/resource.ts holds that separate fact: one series, not a whole calendar).
export const ICS_MAX_BYTES = 5 * 1024 * 1024;

// What a calendar's name and color may be, shared FE/BE: `createCalendar` / `updateCalendar` hold the rule
// and every surface — REST, MKCALENDAR, PROPPATCH — inherits it from there.
export const CALENDAR_NAME_MAX_LENGTH = 200;
export const DEFAULT_CALENDAR_COLOR = '#4285f4';
