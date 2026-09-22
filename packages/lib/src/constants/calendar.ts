// A whole `.ics`, shared FE/BE; one CalDAV resource is a separate ceiling, `EVENT_MAX_BYTES` in calendar/resource-store.ts.
export const ICS_MAX_BYTES = 5 * 1024 * 1024;

// Shared FE/BE: `createCalendar` / `updateCalendar` hold the rule, so REST, MKCALENDAR and PROPPATCH inherit it.
export const CALENDAR_NAME_MAX_LENGTH = 200;
export const DEFAULT_CALENDAR_COLOR = '#4285f4';
