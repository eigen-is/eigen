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

// What one import may write, counting every VEVENT of the file: a master is a row plus a recurrence
// expansion on every later range query, and an override is a row too. Set above what `ICS_MAX_BYTES` holds
// (about 9 600 typical events), so the two ceilings agree and the byte one is the one that binds. Both
// bound one FILE, not a calendar: a calendar past them exports whole and imports back only in parts.
export const ICS_IMPORT_MAX_EVENTS = 10_000;
