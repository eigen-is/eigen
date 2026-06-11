// Pure pattern helpers for the custom-format dialogs. The date/time dialog
// edits a numfmt pattern as an ordered list of segments — token chips with a
// selected variant, and literal text between them — so it needs an exact
// pattern ⇄ segments round-trip. Tokens follow the Google Sheets builder:
// uppercase M is month and lowercase m is minute, h is 12-hour and H is
// 24-hour (numfmt itself decides 12h/24h by AM/PM presence at render time).

import { update } from '../../engine/format';

export type DateTokenId =
    | 'day'
    | 'month'
    | 'year'
    | 'hour'
    | 'minute'
    | 'second'
    | 'millisecond'
    | 'ampm'
    | 'elapsedHours'
    | 'elapsedMinutes'
    | 'elapsedSeconds';

export type FormatSegment = { kind: 'token'; token: DateTokenId; pattern: string } | { kind: 'literal'; text: string };

export type DateTokenVariant = {
    label: string;
    // Static example for the fixed sample Tue 1930-08-05 13:30:30 — hour examples
    // can't be computed from the pattern alone because numfmt switches h/H to
    // 12-hour only when AM/PM is present.
    example: string;
    pattern: string;
};

export type DateToken = {
    id: DateTokenId;
    label: string;
    group: 'date' | 'time' | 'duration';
    // Pattern used when the token is inserted via the + menu.
    insertPattern: string;
    variants: DateTokenVariant[];
};

export const DATE_TOKENS: DateToken[] = [
    {
        id: 'day',
        label: 'Day',
        group: 'date',
        insertPattern: 'dd',
        variants: [
            { label: 'Day without leading zero', example: '5', pattern: 'd' },
            { label: 'Day with leading zero', example: '05', pattern: 'dd' },
            { label: 'Day as abbreviation', example: 'Tue', pattern: 'ddd' },
            { label: 'Day as full name', example: 'Tuesday', pattern: 'dddd' },
        ],
    },
    {
        id: 'month',
        label: 'Month',
        group: 'date',
        insertPattern: 'MM',
        variants: [
            { label: 'Month without leading zero', example: '8', pattern: 'M' },
            { label: 'Month with leading zero', example: '08', pattern: 'MM' },
            { label: 'Month as abbreviation', example: 'Aug', pattern: 'MMM' },
            { label: 'Month as full name', example: 'August', pattern: 'MMMM' },
            { label: 'First letter of the month', example: 'A', pattern: 'MMMMM' },
        ],
    },
    {
        id: 'year',
        label: 'Year',
        group: 'date',
        insertPattern: 'yyyy',
        variants: [
            { label: 'Two-digit year', example: '30', pattern: 'yy' },
            { label: 'Full numeric year', example: '1930', pattern: 'yyyy' },
        ],
    },
    {
        id: 'hour',
        label: 'Hour',
        group: 'time',
        insertPattern: 'HH',
        variants: [
            { label: 'Hour 1–12', example: '1', pattern: 'h' },
            { label: 'Hour 01–12', example: '01', pattern: 'hh' },
            { label: 'Hour 0–23', example: '13', pattern: 'H' },
            { label: 'Hour 00–23', example: '13', pattern: 'HH' },
        ],
    },
    {
        id: 'minute',
        label: 'Minute',
        group: 'time',
        insertPattern: 'mm',
        variants: [
            { label: 'Minute without leading zero', example: '30', pattern: 'm' },
            { label: 'Minute with leading zero', example: '30', pattern: 'mm' },
        ],
    },
    {
        id: 'second',
        label: 'Second',
        group: 'time',
        insertPattern: 'ss',
        variants: [
            { label: 'Second without leading zero', example: '30', pattern: 's' },
            { label: 'Second with leading zero', example: '30', pattern: 'ss' },
        ],
    },
    {
        id: 'millisecond',
        label: 'Millisecond',
        group: 'time',
        insertPattern: '000',
        variants: [{ label: 'Millisecond', example: '023', pattern: '000' }],
    },
    {
        id: 'ampm',
        label: 'a.m./p.m.',
        group: 'time',
        insertPattern: 'AM/PM',
        variants: [{ label: 'a.m./p.m.', example: 'PM', pattern: 'AM/PM' }],
    },
    {
        id: 'elapsedHours',
        label: 'Elapsed hours',
        group: 'duration',
        insertPattern: '[h]',
        variants: [{ label: 'Elapsed hours', example: '268213', pattern: '[h]' }],
    },
    {
        id: 'elapsedMinutes',
        label: 'Elapsed minutes',
        group: 'duration',
        insertPattern: '[m]',
        variants: [{ label: 'Elapsed minutes', example: '16092810', pattern: '[m]' }],
    },
    {
        id: 'elapsedSeconds',
        label: 'Elapsed seconds',
        group: 'duration',
        insertPattern: '[s]',
        variants: [{ label: 'Elapsed seconds', example: '965568630', pattern: '[s]' }],
    },
];

export function getDateToken(id: DateTokenId): DateToken {
    return DATE_TOKENS.find((t) => t.id === id)!;
}

// Tue 1930-08-05 13:30:30 as an Excel serial — the fixed preview sample, chosen
// so the chip examples above match the rendered preview.
export const DATETIME_SAMPLE_SERIAL = 11175.562847222222;

// Known token runs per pattern character, longest first for greedy matching.
const TOKEN_RUNS: Record<string, { token: DateTokenId; patterns: string[] }> = {
    d: { token: 'day', patterns: ['dddd', 'ddd', 'dd', 'd'] },
    M: { token: 'month', patterns: ['MMMMM', 'MMMM', 'MMM', 'MM', 'M'] },
    y: { token: 'year', patterns: ['yyyy', 'yy'] },
    h: { token: 'hour', patterns: ['hh', 'h'] },
    H: { token: 'hour', patterns: ['HH', 'H'] },
    m: { token: 'minute', patterns: ['mm', 'm'] },
    s: { token: 'second', patterns: ['ss', 's'] },
};

const ELAPSED_TOKENS: Record<string, DateTokenId> = {
    h: 'elapsedHours',
    m: 'elapsedMinutes',
    s: 'elapsedSeconds',
};

export function tokenizePattern(pattern: string): FormatSegment[] {
    const segments: FormatSegment[] = [];
    let literal = '';
    const flushLiteral = () => {
        if (literal) {
            segments.push({ kind: 'literal', text: literal });
            literal = '';
        }
    };

    let i = 0;
    while (i < pattern.length) {
        const char = pattern[i];

        if (char === '"') {
            const end = pattern.indexOf('"', i + 1);
            flushLiteral();
            segments.push({ kind: 'literal', text: end === -1 ? pattern.slice(i + 1) : pattern.slice(i + 1, end) });
            i = end === -1 ? pattern.length : end + 1;
            continue;
        }

        if (char === '\\' && i + 1 < pattern.length) {
            flushLiteral();
            segments.push({ kind: 'literal', text: pattern[i + 1] });
            i += 2;
            continue;
        }

        if (/^am\/pm/i.test(pattern.slice(i))) {
            flushLiteral();
            segments.push({ kind: 'token', token: 'ampm', pattern: 'AM/PM' });
            i += 'AM/PM'.length;
            continue;
        }

        const elapsed = pattern.slice(i).match(/^\[(h+|m+|s+)\]/i);
        if (elapsed) {
            flushLiteral();
            const unit = elapsed[1][0].toLowerCase();
            segments.push({ kind: 'token', token: ELAPSED_TOKENS[unit], pattern: `[${unit}]` });
            i += elapsed[0].length;
            continue;
        }

        // A 000 run is the millisecond token only directly after s/ss + '.';
        // anywhere else 000 is a plain digit mask and stays a literal.
        if (pattern.startsWith('000', i) && pattern[i + 3] !== '0' && /(^|[^s])ss?\.$/.test(pattern.slice(0, i))) {
            flushLiteral();
            segments.push({ kind: 'token', token: 'millisecond', pattern: '000' });
            i += 3;
            continue;
        }

        const run = TOKEN_RUNS[char];
        if (run) {
            let length = 1;
            while (pattern[i + length] === char) length += 1;
            const match = run.patterns.find((p) => p.length <= length);
            if (match) {
                flushLiteral();
                segments.push({ kind: 'token', token: run.token, pattern: match });
                i += match.length;
                continue;
            }
        }

        literal += char;
        i += 1;
    }

    flushLiteral();
    return segments;
}

// Characters numfmt passes through verbatim — anything else gets quoted.
const RAW_LITERAL = /^[ \-/:.,]*$/;

export function serializeSegments(segments: FormatSegment[]): string {
    let out = '';
    for (const segment of segments) {
        if (segment.kind === 'token') {
            out += segment.pattern;
        } else if (RAW_LITERAL.test(segment.text)) {
            out += segment.text;
        } else {
            // A double quote cannot be escaped inside a quoted literal — drop it.
            out += `"${segment.text.replaceAll('"', '')}"`;
        }
    }
    return out;
}

// Guarded sample rendering for the dialogs' Preview/Sample line: numfmt throws
// on illegal patterns (e.g. a 000 run straight after yyyy, or adjacent '.,'),
// and a throw during render would blank the whole app.
export function previewPattern(
    pattern: string,
    value: number,
): { ok: true; text: string } | { ok: false; error: string } {
    try {
        return { ok: true, text: update(pattern, value) };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

export type CurrencyVariantId = 'symbolFirst' | 'symbolFirstRounded' | 'symbolLast' | 'symbolLastRounded';

export const CURRENCY_VARIANTS: { id: CurrencyVariantId; mask: string; symbolFirst: boolean }[] = [
    { id: 'symbolFirst', mask: '#,##0.00', symbolFirst: true },
    { id: 'symbolFirstRounded', mask: '#,##0', symbolFirst: true },
    { id: 'symbolLast', mask: '#,##0.00', symbolFirst: false },
    { id: 'symbolLastRounded', mask: '#,##0', symbolFirst: false },
];

export function buildCurrencyPattern(symbol: string, variantId: CurrencyVariantId): string {
    // Bare currency glyphs (€, $, £, ¥, ₼, …) pass through numfmt unquoted, which
    // keeps the EUR pattern identical to the menu's Currency preset. Text symbols
    // (kr, Lek, din, …) would be parsed as format tokens, so quote them.
    const cleaned = symbol.replaceAll('"', '');
    const literal = /^\p{Sc}+$/u.test(cleaned) ? cleaned : `"${cleaned}"`;
    const variant = CURRENCY_VARIANTS.find((v) => v.id === variantId)!;
    return variant.symbolFirst ? `${literal}${variant.mask}` : `${variant.mask}${literal}`;
}

export const NUMBER_FORMAT_PRESETS = [
    '#,##0',
    '0.00',
    '0',
    '#,##0.00',
    '#,##0_);(#,##0)',
    '#,##0_);[Red](#,##0)',
    '#,##0.00_);(#,##0.00)',
    '#,##0.00_);[Red](#,##0.00)',
    '0%',
    '0.00%',
    '0.00E+00',
    '# ?/?',
    '# ??/??',
    '@',
];
