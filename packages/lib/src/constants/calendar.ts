// One whole `.ics`, shared FE/BE: the preview guard and the import refuse a bigger file. Both parse the
// file in one pass the way a CalDAV PUT does, which is what keeps it well under the 20 MiB one CalDAV
// resource may be (caldav/resource.ts holds that separate fact: one series, not a whole calendar).
export const ICS_MAX_BYTES = 5 * 1024 * 1024;
