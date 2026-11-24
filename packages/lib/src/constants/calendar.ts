// Calendar limits, defaults and words the API and the apps share, such as the largest `.ics` a surface accepts, how
// long a new event starts and the label of each share permission.

import type { CalendarShare } from '../types/calendar';

// A whole `.ics`, shared FE/BE so a surface refuses an oversize file before uploading it; one CalDAV resource is a separate ceiling, `EVENT_MAX_BYTES` in calendar/resource-store.ts.
export const ICS_MAX_BYTES = 5 * 1024 * 1024;

// Shared FE/BE: `createCalendar` / `updateCalendar` hold the rule, so REST, MKCALENDAR and PROPPATCH inherit it.
export const CALENDAR_NAME_MAX_LENGTH = 200;
export const DEFAULT_CALENDAR_COLOR = '#4285f4';

// As Google Calendar, wherever an event is made: Create event, the c key and a click on the time grid.
export const NEW_EVENT_MINUTES = 60;

// The words for each share permission, in this order wherever a person picks one.
export const CALENDAR_PERMISSION_LABELS: Record<CalendarShare['permission'], string> = {
    write: 'Can edit',
    read: 'Can view',
    'free-busy': 'Free/busy',
};
