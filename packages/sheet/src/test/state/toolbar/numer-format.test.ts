// Pins the Format → Number menu presets (en.defaultFmt) through the canonical
// apply path: updateFormat → updateFormatCell derives ct.t from the format
// string (is_date → 'd', '@' → 's', 'General' → 'n'/'g') and sets cell.m via
// numfmt. Exact rendered strings are pinned so preset changes are deliberate.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { en } from '../../../state/locale/en';
import { updateFormat } from '../../../state/modules/toolbar';
import type { Cell } from '../../../state/types';
import { contextFactory } from '../factories/context';

// updateFormat only reads the input element for inline-style attrs, never for 'ct'.
const cellInput = {} as HTMLDivElement;

function applyFormat(value: Cell['v'], fa: string): Cell {
    const ctx = contextFactory() as Context;
    const data = ctx.sheets[0].data!;
    data[0][1] = { v: value, m: String(value), ct: { fa: 'General', t: typeof value === 'number' ? 'n' : 's' } };
    updateFormat(ctx, cellInput, data, 'ct', fa);
    return data[0][1]!;
}

const PRESETS = en.defaultFmt('€');

function presetValue(text: string): string {
    const preset = PRESETS.find((p) => p.text === text);
    if (!preset) throw new Error(`menu preset not found: ${text}`);
    return preset.value;
}

describe('Format → Number menu presets', () => {
    test('menu lists the Google-structure presets with their format strings', () => {
        expect(PRESETS.filter((p) => p.value !== 'split').map((p) => [p.text, p.value])).toEqual([
            ['Automatic', 'General'],
            ['Plain text', '@'],
            ['Number', '#,##0.00'],
            ['Percent', '0.00%'],
            ['Scientific', '0.00E+00'],
            ['Accounting', '_(€* #,##0.00_);_(€* (#,##0.00);_(€* "-"??_);_(@_)'],
            ['Financial', '#,##0.00;(#,##0.00)'],
            ['Currency', '€#,##0.00'],
            ['Currency rounded', '€#,##0'],
            ['Date', 'dd/MM/yyyy'],
            ['Time', 'HH:mm:ss'],
            ['Date time', 'dd/MM/yyyy HH:mm:ss'],
            ['Duration', '[h]:mm:ss'],
        ]);
    });

    test('Automatic keeps a numeric cell numeric', () => {
        const cell = applyFormat(1000.12, presetValue('Automatic'));
        expect(cell.ct).toEqual({ fa: 'General', t: 'n' });
        expect(cell.m).toBe('1000.12');
    });

    test('Plain text turns a number into a string cell', () => {
        const cell = applyFormat(1000.12, presetValue('Plain text'));
        expect(cell.ct).toEqual({ fa: '@', t: 's' });
        expect(cell.m).toBe('1000.12');
    });

    test('Plain text keeps a string cell as string', () => {
        const cell = applyFormat('hello', presetValue('Plain text'));
        expect(cell.ct).toEqual({ fa: '@', t: 's' });
        expect(cell.m).toBe('hello');
    });

    test('Number renders thousands separator and two decimals', () => {
        const cell = applyFormat(1000.12, presetValue('Number'));
        expect(cell.ct).toEqual({ fa: '#,##0.00', t: 'n' });
        expect(cell.m).toBe('1,000.12');
    });

    test('Percent renders the ratio as a percentage', () => {
        const cell = applyFormat(0.1012, presetValue('Percent'));
        expect(cell.ct).toEqual({ fa: '0.00%', t: 'n' });
        expect(cell.m).toBe('10.12%');
    });

    test('Scientific renders exponent notation', () => {
        const cell = applyFormat(1012.34, presetValue('Scientific'));
        expect(cell.ct).toEqual({ fa: '0.00E+00', t: 'n' });
        expect(cell.m).toBe('1.01E+03');
    });

    test('Accounting pads positive values', () => {
        const cell = applyFormat(1000.12, presetValue('Accounting'));
        expect(cell.ct?.t).toBe('n');
        expect(cell.m).toBe(' €1,000.12 ');
    });

    test('Accounting wraps negative values in parentheses', () => {
        const cell = applyFormat(-1000.12, presetValue('Accounting'));
        expect(cell.ct?.t).toBe('n');
        expect(cell.m).toBe(' €(1,000.12)');
    });

    test('Financial renders positives plain', () => {
        const cell = applyFormat(1000.12, presetValue('Financial'));
        expect(cell.ct).toEqual({ fa: '#,##0.00;(#,##0.00)', t: 'n' });
        expect(cell.m).toBe('1,000.12');
    });

    test('Financial wraps negatives in parentheses', () => {
        const cell = applyFormat(-1000.12, presetValue('Financial'));
        expect(cell.m).toBe('(1,000.12)');
    });

    test('Currency prefixes the symbol', () => {
        const cell = applyFormat(1234.56, presetValue('Currency'));
        expect(cell.ct).toEqual({ fa: '€#,##0.00', t: 'n' });
        expect(cell.m).toBe('€1,234.56');
    });

    test('Currency rounded drops the decimals', () => {
        const cell = applyFormat(1234.56, presetValue('Currency rounded'));
        expect(cell.ct).toEqual({ fa: '€#,##0', t: 'n' });
        expect(cell.m).toBe('€1,235');
    });

    test('Date derives ct.t = d and renders dd/MM/yyyy', () => {
        // 39717.66597… = 2008-09-26 15:59:00
        const cell = applyFormat(39717.665972222225, presetValue('Date'));
        expect(cell.ct).toEqual({ fa: 'dd/MM/yyyy', t: 'd' });
        expect(cell.m).toBe('26/09/2008');
    });

    test('Time derives ct.t = d and renders 24h time', () => {
        const cell = applyFormat(39717.665972222225, presetValue('Time'));
        expect(cell.ct).toEqual({ fa: 'HH:mm:ss', t: 'd' });
        expect(cell.m).toBe('15:59:00');
    });

    test('Date time renders date plus 24h time', () => {
        const cell = applyFormat(39717.665972222225, presetValue('Date time'));
        expect(cell.ct).toEqual({ fa: 'dd/MM/yyyy HH:mm:ss', t: 'd' });
        expect(cell.m).toBe('26/09/2008 15:59:00');
    });

    test('Duration derives ct.t = d and renders elapsed hours', () => {
        const cell = applyFormat(1.000694444444, presetValue('Duration'));
        expect(cell.ct).toEqual({ fa: '[h]:mm:ss', t: 'd' });
        expect(cell.m).toBe('24:01:00');
    });

    test('the currency symbol parameter flows into the currency presets', () => {
        const dollar = en.defaultFmt('$');
        expect(dollar.find((p) => p.text === 'Currency')?.value).toBe('$#,##0.00');
        expect(dollar.find((p) => p.text === 'Accounting')?.value).toBe(
            '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)',
        );
    });
});
