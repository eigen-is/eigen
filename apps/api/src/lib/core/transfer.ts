import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';

// What a whole-file transfer refuses, and what it answers with. Every fact here is the server's alone: the
// route that ingests the file, the domain that parses it and the preview builder that reads it are all in
// this app, so none of it is shared with a frontend. The two ceilings a surface does need — the byte size
// it refuses a file at before uploading — stay in packages/lib beside the file types.

// One spelling per format, shared by the route, the domain and the preview guard that refuses the file
// before its bytes are read.
export const NOT_A_VCARD_FILE = 'Not a vCard file';
export const NOT_AN_EMAIL_FILE = 'Not an email file';
export const NOT_A_CALENDAR_FILE = 'Not a calendar file';

// A `.vcf` and an `.ics` are UTF-8 (RFC 6350 §3.1, RFC 5545 §3.1). Another encoding is its own answer,
// not "not a calendar": decoded leniently it would store a U+FFFD in every accented name and re-serve it
// to every DAV client.
export const NOT_UTF8_FILE = 'File is not UTF-8 encoded';

// The decode every whole-file transfer takes, imports and previews alike; null is "not UTF-8", which each
// caller answers with its own status.
export function decodeUtf8Strict(bytes: Uint8Array | ArrayBuffer): string | null {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
}

// The two ceilings a vCard import is bounded by: a file with more cards than this is refused right after
// the split, and the export body schema caps one selection at the same number.
export const VCARD_IMPORT_MAX_CARDS = 1000;

// A quick look reads, it doesn't scroll a whole address book: past this the preview serves counts only.
export const VCARD_PREVIEW_MAX_CARDS = 200;

// What one import may write, counting every VEVENT of the file: a master is a row plus a recurrence
// expansion on every later range query, an override is a row too, and a file past this is a whole
// account's history rather than a calendar moved by hand.
export const ICS_IMPORT_MAX_EVENTS = 1000;

// What one import may store. A series is one resource, so a VTIMEZONE the file defines once is copied into
// every series that names it and a file well inside its own ceiling can ask for many times its size on
// disk. Past this the run stops the way a quota stop does; a retry continues, since what landed skips by UID.
export const ICS_IMPORT_MAX_WRITTEN_BYTES = 8 * ICS_MAX_BYTES;

// What one `.ics` preview may carry. A calendar export is a year of a team's meetings and an event's
// description is a whole agenda, so the builder is where the payload is bounded.
export const ICS_PREVIEW_MAX_EVENTS = 200;
export const ICS_PREVIEW_MAX_DESCRIPTION_CHARS = 10_000;
export const ICS_PREVIEW_MAX_ATTENDEES = 100;

// What one `.eml` preview may carry. The parser bounds none of them: it leaves the body unbounded and
// copies an inlined `cid:` image once per reference, so the builder is where the payload is bounded.
export const EML_PREVIEW_MAX_ATTACHMENTS = 50;
export const EML_PREVIEW_MAX_HTML_BYTES = 2 * 1024 * 1024;
// A character count, like the parser's own body ceilings (mail-parser/html.ts).
export const EML_PREVIEW_MAX_TEXT_CHARS = 1024 * 1024;
