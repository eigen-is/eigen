// One ceiling for every XML request body CalDAV and CardDAV read (PROPFIND, REPORT, MKCALENDAR, PROPPATCH): each is a
// small prop list or href list, bounded before it reaches a parser, which holds about 100× its input. WebDAV passes its own.
export const DAV_BODY_MAX_BYTES = 1_048_576;
