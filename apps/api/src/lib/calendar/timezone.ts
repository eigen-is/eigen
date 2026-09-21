// One file names the same handful of zones on every event it holds, and constructing the formatter is
// what makes the check an oracle — so each answer is remembered. The keys are a stranger's TZIDs, so the
// memo is bounded and dropped whole when it fills rather than grown.
const MAX_MEMOIZED_ZONES = 64;
const answers = new Map<string, string | null>();

// Validate an IANA timezone at the ingestion boundary — Intl.DateTimeFormat throws RangeError on a
// non-IANA zone, e.g. Outlook routinely emits "W. Europe Standard Time". Constructing the formatter
// here is the exact oracle the Intl consumers use, so we degrade anything they'd reject to null
// (floating, what "no timezone" already means) and store it in that safe form. Rows stored before
// this guard existed are healed the same way at read time: getIntlFormatter and buildVEvent reuse
// this; formatEventWhen (shared packages/lib, which can't import apps/api) has a local equivalent.
export function normalizeTimezone(tz: string | null | undefined): string | null {
    if (!tz) return null;

    const remembered = answers.get(tz);
    if (remembered !== undefined) return remembered;

    let answer: string | null;
    try {
        new Intl.DateTimeFormat('en-GB', { timeZone: tz });
        answer = tz;
    } catch {
        answer = null;
    }

    if (answers.size >= MAX_MEMOIZED_ZONES) answers.clear();
    answers.set(tz, answer);
    return answer;
}
