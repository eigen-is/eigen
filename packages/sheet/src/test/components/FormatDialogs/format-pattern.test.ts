// Pins the pure pattern helpers behind the custom-format dialogs: the date/time
// pattern ⇄ segments round-trip (tokenizer + serializer), the currency pattern
// builder, and the number-dialog preset samples. Rendered strings come from
// numfmt via engine/format.update against the fixed sample Tue 1930-08-05
// 13:30:30 (serial 11175.5628…), so chip examples and previews stay truthful.

import { describe, expect, test } from 'bun:test';
import {
    buildCurrencyPattern,
    CURRENCY_VARIANTS,
    DATE_TOKENS,
    DATETIME_SAMPLE_SERIAL,
    type DateTokenId,
    type FormatSegment,
    NUMBER_FORMAT_PRESETS,
    previewPattern,
    serializeSegments,
    tokenizePattern,
} from '../../../components/FormatDialogs/format-pattern';
import { update } from '../../../engine/format';
import { DATE_FORMAT_PRESETS } from '../../../state/modules/format-presets';

function token(tokenId: DateTokenId, pattern: string): FormatSegment {
    return { kind: 'token', token: tokenId, pattern };
}

function literal(text: string): FormatSegment {
    return { kind: 'literal', text };
}

describe('tokenizePattern / serializeSegments round-trip', () => {
    test('every date/time preset round-trips to the exact same pattern', () => {
        for (const { value } of DATE_FORMAT_PRESETS) {
            expect(serializeSegments(tokenizePattern(value))).toBe(value);
        }
    });

    test('the preset list matches the spec', () => {
        expect(DATE_FORMAT_PRESETS.map((p) => [p.name, p.value])).toEqual([
            ['5-Aug-1930', 'd-MMM-yyyy'],
            ['5 Aug 1930', 'd MMM yyyy'],
            ['5 August 1930', 'd MMMM yyyy'],
            ['05/08/1930', 'dd/MM/yyyy'],
            ['05/08/30', 'dd/MM/yy'],
            ['05/08', 'dd/MM'],
            ['1930-08-05', 'yyyy-MM-dd'],
            ['13:30', 'HH:mm'],
            ['13:30:30', 'HH:mm:ss'],
            ['1:30 PM', 'h:mm AM/PM'],
            ['1:30:30 PM', 'h:mm:ss AM/PM'],
            ['05/08 13:30', 'dd/MM HH:mm'],
            ['05/08/1930 13:30', 'dd/MM/yyyy HH:mm'],
            ['Tuesday, 5 August 1930', 'dddd, d MMMM yyyy'],
            ['Tuesday, 5 August 1930 at 13:30:30', 'dddd, d MMMM yyyy "at" HH:mm:ss'],
            ['24:01:00 (elapsed)', '[h]:mm:ss'],
        ]);
    });

    test('every preset example except the elapsed row is the live rendering of its pattern', () => {
        for (const { name, value } of DATE_FORMAT_PRESETS) {
            if (value === '[h]:mm:ss') continue; // example shows a small duration, not the 1930 sample
            expect(update(value, DATETIME_SAMPLE_SERIAL)).toBe(name);
        }
    });

    test('every token variant tokenizes to a single chip and round-trips', () => {
        for (const { id, variants } of DATE_TOKENS) {
            for (const { pattern } of variants) {
                // A lone 000 is just a digit mask — the millisecond token only exists after s/ss + '.'
                const probe = id === 'millisecond' ? `ss.${pattern}` : pattern;
                const segments = tokenizePattern(probe);
                const chip = segments[segments.length - 1];
                expect(chip).toEqual(token(id, pattern));
                expect(serializeSegments(segments)).toBe(probe);
            }
        }
    });

    test('a full preset tokenizes into the expected chips and literals', () => {
        expect(tokenizePattern('dddd, d MMMM yyyy "at" HH:mm:ss')).toEqual([
            token('day', 'dddd'),
            literal(', '),
            token('day', 'd'),
            literal(' '),
            token('month', 'MMMM'),
            literal(' '),
            token('year', 'yyyy'),
            literal(' '),
            literal('at'),
            literal(' '),
            token('hour', 'HH'),
            literal(':'),
            token('minute', 'mm'),
            literal(':'),
            token('second', 'ss'),
        ]);
    });

    test('alphanumeric literals serialize quoted, separators stay raw', () => {
        expect(serializeSegments([token('day', 'd'), literal(' of '), token('month', 'MMMM')])).toBe('d" of "MMMM');
        expect(serializeSegments([token('hour', 'HH'), literal(':'), token('minute', 'mm')])).toBe('HH:mm');
    });

    test('empty literals collapse on serialize', () => {
        expect(serializeSegments([token('day', 'dd'), literal(''), token('month', 'MM')])).toBe('ddMM');
    });

    test('millisecond rule: 000 after s/ss + dot is the token, elsewhere a literal', () => {
        expect(tokenizePattern('hh:mm:ss.000')).toEqual([
            token('hour', 'hh'),
            literal(':'),
            token('minute', 'mm'),
            literal(':'),
            token('second', 'ss'),
            literal('.'),
            token('millisecond', '000'),
        ]);
        expect(update('hh:mm:ss.000', DATETIME_SAMPLE_SERIAL)).toBe('13:30:30.000');
        expect(tokenizePattern('000')).toEqual([literal('000')]);
        expect(tokenizePattern('mm.000')).toEqual([token('minute', 'mm'), literal('.000')]);
    });

    test('escaped characters become literals', () => {
        expect(tokenizePattern('d\\h')).toEqual([token('day', 'd'), literal('h')]);
    });

    test('unknown tokens fall back to literals and stay literal after round-trip', () => {
        expect(tokenizePattern('yyy')).toEqual([token('year', 'yy'), literal('y')]);
        expect(serializeSegments(tokenizePattern('yyy'))).toBe('yy"y"');
        expect(tokenizePattern('yy"y"')).toEqual([token('year', 'yy'), literal('y')]);
        expect(tokenizePattern('Q')).toEqual([literal('Q')]);
    });

    test('greedy longest-match: runs longer than the largest variant split into chips', () => {
        expect(tokenizePattern('ddddd')).toEqual([token('day', 'dddd'), token('day', 'd')]);
        expect(tokenizePattern('MMMMMM')).toEqual([token('month', 'MMMMM'), token('month', 'M')]);
    });

    test('AM/PM is case-insensitive on input and canonical on output', () => {
        expect(tokenizePattern('h:mm am/pm')).toEqual([
            token('hour', 'h'),
            literal(':'),
            token('minute', 'mm'),
            literal(' '),
            token('ampm', 'AM/PM'),
        ]);
        expect(serializeSegments(tokenizePattern('h:mm am/pm'))).toBe('h:mm AM/PM');
    });

    test('h vs H with and without AM/PM: numfmt renders 12h whenever AM/PM is present', () => {
        expect(update('h:mm', DATETIME_SAMPLE_SERIAL)).toBe('13:30');
        expect(update('H:mm', DATETIME_SAMPLE_SERIAL)).toBe('13:30');
        expect(update('h:mm AM/PM', DATETIME_SAMPLE_SERIAL)).toBe('1:30 PM');
        expect(update('H:mm AM/PM', DATETIME_SAMPLE_SERIAL)).toBe('1:30 PM');
        expect(update('hh:mm AM/PM', DATETIME_SAMPLE_SERIAL)).toBe('01:30 PM');
        expect(update('HH:mm AM/PM', DATETIME_SAMPLE_SERIAL)).toBe('01:30 PM');
    });

    test('elapsed tokens round-trip and render running totals', () => {
        expect(tokenizePattern('[h]:mm:ss')).toEqual([
            token('elapsedHours', '[h]'),
            literal(':'),
            token('minute', 'mm'),
            literal(':'),
            token('second', 'ss'),
        ]);
        expect(update('[h]:mm:ss', 1.000694444444)).toBe('24:01:00');
        expect(update('[m]', DATETIME_SAMPLE_SERIAL)).toBe('16092810');
        expect(update('[s]', DATETIME_SAMPLE_SERIAL)).toBe('965568630');
    });
});

describe('buildCurrencyPattern', () => {
    test('bare currency glyphs stay unquoted in all four variants', () => {
        expect(buildCurrencyPattern('€', 'symbolFirst')).toBe('€#,##0.00');
        expect(buildCurrencyPattern('€', 'symbolFirstRounded')).toBe('€#,##0');
        expect(buildCurrencyPattern('€', 'symbolLast')).toBe('#,##0.00€');
        expect(buildCurrencyPattern('€', 'symbolLastRounded')).toBe('#,##0€');
    });

    test('text symbols are quoted so numfmt treats them as literals', () => {
        expect(buildCurrencyPattern('kr', 'symbolFirst')).toBe('"kr"#,##0.00');
        expect(buildCurrencyPattern('kr', 'symbolFirstRounded')).toBe('"kr"#,##0');
        expect(buildCurrencyPattern('kr', 'symbolLast')).toBe('#,##0.00"kr"');
        expect(buildCurrencyPattern('kr', 'symbolLastRounded')).toBe('#,##0"kr"');
    });

    test('all four variants render correctly for glyph and text symbols', () => {
        expect(update(buildCurrencyPattern('€', 'symbolFirst'), 1000)).toBe('€1,000.00');
        expect(update(buildCurrencyPattern('€', 'symbolFirstRounded'), 1000)).toBe('€1,000');
        expect(update(buildCurrencyPattern('€', 'symbolLast'), 1000)).toBe('1,000.00€');
        expect(update(buildCurrencyPattern('€', 'symbolLastRounded'), 1000)).toBe('1,000€');
        expect(update(buildCurrencyPattern('Lek', 'symbolFirst'), 1000.12)).toBe('Lek1,000.12');
        expect(update(buildCurrencyPattern('грн.', 'symbolLast'), 1000.12)).toBe('1,000.12грн.');
        expect(update(buildCurrencyPattern('₼', 'symbolFirst'), 1000.12)).toBe('₼1,000.12');
        expect(update(buildCurrencyPattern('₹', 'symbolFirst'), 1000.12)).toBe('₹1,000.12');
    });

    test('the variant list covers exactly the four spec variants in order', () => {
        expect(CURRENCY_VARIANTS.map((v) => v.id)).toEqual([
            'symbolFirst',
            'symbolFirstRounded',
            'symbolLast',
            'symbolLastRounded',
        ]);
    });

    test('double quotes cannot be represented and are stripped', () => {
        expect(buildCurrencyPattern('a"b', 'symbolFirst')).toBe('"ab"#,##0.00');
    });
});

describe('NUMBER_FORMAT_PRESETS samples', () => {
    test('every preset renders the pinned sample for 1234.56', () => {
        const expected: [string, string][] = [
            ['#,##0', '1,235'],
            ['0.00', '1234.56'],
            ['0', '1235'],
            ['#,##0.00', '1,234.56'],
            ['#,##0_);(#,##0)', '1,235 '],
            ['#,##0_);[Red](#,##0)', '1,235 '],
            ['#,##0.00_);(#,##0.00)', '1,234.56 '],
            ['#,##0.00_);[Red](#,##0.00)', '1,234.56 '],
            ['0%', '123456%'],
            ['0.00%', '123456.00%'],
            ['0.00E+00', '1.23E+03'],
            ['# ?/?', '1234 5/9'],
            ['# ??/??', '1234 14/25'],
            ['@', '1234.56'],
        ];
        expect(NUMBER_FORMAT_PRESETS.map((p) => [p, update(p, 1234.56)])).toEqual(expected);
    });

    test('an invalid pattern makes update throw — the dialog error state relies on this', () => {
        expect(() => update('#,##0.00"', 1234.56)).toThrow();
    });
});

describe('previewPattern', () => {
    test('a valid pattern renders the sample', () => {
        expect(previewPattern('dd/MM/yyyy', DATETIME_SAMPLE_SERIAL)).toEqual({ ok: true, text: '05/08/1930' });
    });

    test('a millisecond token appended after the year is an error, not a throw', () => {
        expect(previewPattern('dd/MM/yyyy000', DATETIME_SAMPLE_SERIAL)).toEqual({
            ok: false,
            error: 'Illegal format',
        });
    });

    test('adjacent .-and-, literals are an error, not a throw', () => {
        expect(previewPattern('dd.,MM/yyyy', DATETIME_SAMPLE_SERIAL)).toEqual({ ok: false, error: 'Illegal format' });
    });

    test('a quoted literal that round-trips to a raw separator run previews as an error', () => {
        // 'dd".,"MM' renders fine quoted, but the tokenizer extracts the '.,'
        // literal and the serializer re-emits it raw as 'dd.,MM' — illegal.
        const roundTripped = serializeSegments(tokenizePattern('dd".,"MM'));
        expect(roundTripped).toBe('dd.,MM');
        expect(previewPattern(roundTripped, DATETIME_SAMPLE_SERIAL)).toEqual({
            ok: false,
            error: 'Illegal format',
        });
    });

    test('an unterminated quote in a number pattern is an error, not a throw', () => {
        expect(previewPattern('#,##0.00"', 1234.56)).toEqual({ ok: false, error: 'Illegal character: #,##0.00"' });
    });
});
