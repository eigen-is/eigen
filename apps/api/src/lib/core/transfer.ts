// Server-only: the route, the domain and the preview builder all live here, so a frontend shares none of it — the byte ceilings stay in packages/lib.

// One spelling per format for the route, the domain and the preview guard.
export const NOT_A_VCARD_FILE = 'Not a vCard file';
export const NOT_AN_EMAIL_FILE = 'Not an email file';
export const NOT_A_CALENDAR_FILE = 'Not a calendar file';

// A `.vcf` and an `.ics` are UTF-8 (RFC 6350 §3.1, RFC 5545 §3.1): decoded leniently, another encoding stores a U+FFFD in every accented name.
export const NOT_UTF8_FILE = 'File is not UTF-8 encoded';

export function decodeUtf8Strict(bytes: Uint8Array | ArrayBuffer): string | null {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
}

// A file with more cards is refused right after the split, and the export body schema caps a selection at the same number.
export const VCARD_IMPORT_MAX_CARDS = 1000;

// Counts every VEVENT of one FILE, not a calendar, and sits above what `ICS_MAX_BYTES` holds (~9 600 typical events) so the byte ceiling binds first.
export const ICS_IMPORT_MAX_EVENTS = 10_000;
