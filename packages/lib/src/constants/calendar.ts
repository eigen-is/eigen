// Calendar limits and words both the API and the apps need, such as the largest `.ics` a surface accepts and the
// label of each share permission.

import type { CalendarShare } from '../types/calendar';

// A whole `.ics`, shared FE/BE so a surface refuses an oversize file before uploading it; one CalDAV resource is a separate ceiling, `EVENT_MAX_BYTES` in calendar/resource-store.ts.
export const ICS_MAX_BYTES = 5 * 1024 * 1024;

// Shared FE/BE: `createCalendar` / `updateCalendar` hold the rule, so REST, MKCALENDAR and PROPPATCH inherit it.
export const CALENDAR_NAME_MAX_LENGTH = 200;
export const DEFAULT_CALENDAR_COLOR = '#4285f4';

// The words for each share permission, in this order wherever a person picks one.
export const CALENDAR_PERMISSION_LABELS: Record<CalendarShare['permission'], string> = {
    write: 'Can edit',
    read: 'Can view',
    'free-busy': 'Free/busy',
};
