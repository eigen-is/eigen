// One whole `.ics`, shared FE/BE: the preview guard and the import refuse a bigger file. Both parse the
// file in one pass the way a CalDAV PUT does, which is what keeps it well under the 20 MiB one CalDAV
// resource may be (caldav/resource.ts holds that separate fact: one series, not a whole calendar).
export const ICS_MAX_BYTES = 5 * 1024 * 1024;

// What one `.ics` preview may carry. A calendar export is a year of a team's meetings and an event's
// description is a whole agenda, so the builder is where the payload is bounded.
export const ICS_PREVIEW_MAX_EVENTS = 200;
export const ICS_PREVIEW_MAX_DESCRIPTION_CHARS = 10_000;
export const ICS_PREVIEW_MAX_ATTENDEES = 100;

// What one import may write. Every master is a row plus a recurrence expansion on every later range
// query, and a file past this is a whole account's history rather than a calendar moved by hand.
export const ICS_IMPORT_MAX_EVENTS = 1000;
// An imported event keeps a handful of alarms: a file may carry dozens, and each one is a future
// notification the importing user never asked for.
export const ICS_IMPORT_MAX_REMINDERS = 5;
