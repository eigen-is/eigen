// Pattern helpers for the custom number, date and currency format dialogs. The date and time dialog edits a format
// pattern as a list of segments: token chips, each with a chosen variant, and the literal text between them. So it
// needs a pattern to turn into segments and back exactly. Tokens follow the Google Sheets builder: M is month and m
// is minute, h is the 12-hour clock and H the 24-hour one, though numfmt itself picks the clock from an AM/PM part.

import { numberDisplay, numberFormatError } from '@workspace/formula/format';

// The tokens in the order the dialog's insert menu lists them.
export const DATE_TOKEN_IDS = [
    'day',
    'month',
    'year',
    'hour',
    'minute',
    'second',
    'millisecond',
    'ampm',
    'elapsedHours',
    'elapsedMinutes',
    'elapsedSeconds',
] as const;
export type DateTokenId = (typeof DATE_TOKEN_IDS)[number];

export type FormatSegment = { kind: 'token'; token: DateTokenId; pattern: string } | { kind: 'literal'; text: string };

type DateTokenVariant = {
    label: string;
    // The variant shown on the sample date, Tue 1930-08-05 13:30:30. It is written out, because numfmt only reads h and
    // H as a 12-hour clock when the pattern has AM/PM, so the pattern alone doesn't say how an hour reads.
    example: string;
    pattern: string;
};

type DateToken = {
    label: string;
    group: 'date' | 'time' | 'duration';
    // The variant a token starts with when the dialog's insert menu adds it.
    insertPattern: string;
    variants: DateTokenVariant[];
};

export const DATE_TOKENS: Record<DateTokenId, DateToken> = {
    day: {
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
    month: {
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
    year: {
        label: 'Year',
        group: 'date',
        insertPattern: 'yyyy',
        variants: [
            { label: 'Two-digit year', example: '30', pattern: 'yy' },
            { label: 'Full numeric year', example: '1930', pattern: 'yyyy' },
        ],
    },
    hour: {
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
    minute: {
        label: 'Minute',
        group: 'time',
        insertPattern: 'mm',
        variants: [
            { label: 'Minute without leading zero', example: '30', pattern: 'm' },
            { label: 'Minute with leading zero', example: '30', pattern: 'mm' },
        ],
    },
    second: {
        label: 'Second',
        group: 'time',
        insertPattern: 'ss',
        variants: [
            { label: 'Second without leading zero', example: '30', pattern: 's' },
            { label: 'Second with leading zero', example: '30', pattern: 'ss' },
        ],
    },
    millisecond: {
        label: 'Millisecond',
        group: 'time',
        insertPattern: '000',
        variants: [{ label: 'Millisecond', example: '023', pattern: '000' }],
    },
    ampm: {
        label: 'a.m./p.m.',
        group: 'time',
        insertPattern: 'AM/PM',
        variants: [{ label: 'a.m./p.m.', example: 'PM', pattern: 'AM/PM' }],
    },
    elapsedHours: {
        label: 'Elapsed hours',
        group: 'duration',
        insertPattern: '[h]',
        variants: [{ label: 'Elapsed hours', example: '268213', pattern: '[h]' }],
    },
    elapsedMinutes: {
        label: 'Elapsed minutes',
        group: 'duration',
        insertPattern: '[m]',
        variants: [{ label: 'Elapsed minutes', example: '16092810', pattern: '[m]' }],
    },
    elapsedSeconds: {
        label: 'Elapsed seconds',
        group: 'duration',
        insertPattern: '[s]',
        variants: [{ label: 'Elapsed seconds', example: '965568630', pattern: '[s]' }],
    },
};

// Tue 1930-08-05 13:30:30 as an Excel serial, the date the dialog previews on. The token examples above are this date.
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

// The characters numfmt writes out as they are. Any other literal text is quoted.
const RAW_LITERAL = /^[ \-/:.,]*$/;

export function serializeSegments(segments: FormatSegment[]): string {
    let out = '';
    for (const segment of segments) {
        if (segment.kind === 'token') {
            out += segment.pattern;
        } else if (RAW_LITERAL.test(segment.text)) {
            out += segment.text;
        } else {
            // A quoted literal can't hold a double quote, so it is dropped.
            out += `"${segment.text.replaceAll('"', '')}"`;
        }
    }
    return out;
}

export type FormatPreview = { ok: true; text: string } | { ok: false; error: string };

// A value in a pattern, for a dialog's preview line, or numfmt's reason for a pattern it can't read, such as a 000 run
// right after yyyy, which the dialog shows in place of the preview.
export function previewPattern(pattern: string, value: number): FormatPreview {
    const error = numberFormatError(value, pattern);
    return error === null ? { ok: true, text: numberDisplay(value, pattern) } : { ok: false, error };
}

// The layouts of a currency format, in the order the Custom currencies dialog lists them.
export const CURRENCY_VARIANT_IDS = ['symbolFirst', 'symbolFirstRounded', 'symbolLast', 'symbolLastRounded'] as const;
export type CurrencyVariantId = (typeof CURRENCY_VARIANT_IDS)[number];

const CURRENCY_VARIANTS: Record<CurrencyVariantId, { mask: string; symbolFirst: boolean }> = {
    symbolFirst: { mask: '#,##0.00', symbolFirst: true },
    symbolFirstRounded: { mask: '#,##0', symbolFirst: true },
    symbolLast: { mask: '#,##0.00', symbolFirst: false },
    symbolLastRounded: { mask: '#,##0', symbolFirst: false },
};

export function buildCurrencyPattern(symbol: string, variantId: CurrencyVariantId): string {
    // A currency sign, such as € or ₼, goes in as it is, so the euro pattern is the menu's Currency preset. A symbol
    // written in letters, such as kr or Lek, is quoted, or numfmt would read its letters as format codes.
    const cleaned = symbol.replaceAll('"', '');
    const literal = /^\p{Sc}+$/u.test(cleaned) ? cleaned : `"${cleaned}"`;
    const variant = CURRENCY_VARIANTS[variantId];
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
