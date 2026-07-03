// Validate an IANA timezone at the ingestion boundary — Intl.DateTimeFormat throws RangeError on a
// non-IANA zone, e.g. Outlook routinely emits "W. Europe Standard Time". Constructing the formatter
// here is the exact oracle the Intl consumers use, so we degrade anything they'd reject to null
// (floating/UTC, what "no timezone" already means) and store it in that safe form. Rows stored before
// this guard existed are healed the same way at read time: getIntlFormatter and buildVEvent reuse
// this; formatEventWhen (shared packages/lib, which can't import apps/api) has a local equivalent.
export function normalizeTimezone(tz: string | null | undefined): string | null {
    if (!tz) return null;
    try {
        new Intl.DateTimeFormat('en-GB', { timeZone: tz });
        return tz;
    } catch {
        return null;
    }
}
