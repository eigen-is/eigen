// Validate an IANA timezone at the ingestion boundary. Downstream consumers (getIntlFormatter,
// formatDateTimeInTZ, formatEventWhen) hand the stored value straight to Intl.DateTimeFormat, which
// throws RangeError on a non-IANA zone — e.g. Outlook routinely emits "W. Europe Standard Time".
// Constructing the same Intl formatter here is the exact oracle those consumers use, so we degrade
// anything they'd reject to null (floating/UTC, what "no timezone" already means) and store it in
// that safe form. A bad TZID then can't be persisted and later 500 range fetch / CalDAV / RSVP.
export function normalizeTimezone(tz: string | null | undefined): string | null {
    if (!tz) return null;
    try {
        new Intl.DateTimeFormat('en-GB', { timeZone: tz });
        return tz;
    } catch {
        return null;
    }
}
