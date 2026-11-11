// Pins the Format → Number menu presets (NUMBER_MENU_PRESETS) through the canonical
// apply path: updateFormat → updateFormatCell derives ct.t from the format
// string (is_date → 'd', '@' → 's', 'General' → 'n'/'g') and sets cell.m via
// numfmt. Exact rendered strings are pinned so preset changes are deliberate.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { updateCell } from '../../../state/modules/cell';
import { NUMBER_MENU_PRESETS } from '../../../state/modules/format-presets';
import { updateFormat } from '../../../state/modules/toolbar';
import type { Cell } from '../../../state/types';
import { contextFactory, selectionFactory } from '../factories/context';

// updateFormat only reads the input element for inline-style attrs, never for 'ct'.
const cellInput = {} as HTMLDivElement;

function applyFormat(value: Cell['v'], fa: string): Cell {
    const ctx = contextFactory() as Context;
    const data = ctx.sheets[0].data!;
    data[0][1] = { v: value, m: String(value), ct: { fa: 'General', t: typeof value === 'number' ? 'n' : 's' } };
    updateFormat(ctx, cellInput, data, 'ct', fa);
    return data[0][1]!;
}

const PRESETS = NUMBER_MENU_PRESETS.flat();

function presetValue(text: string): string {
    const preset = PRESETS.find((p) => p.text === text);
    if (!preset) throw new Error(`menu preset not found: ${text}`);
    return preset.value;
}

describe('Format → Number menu presets', () => {
    test('menu lists the Google-structure presets with their format strings', () => {
        expect(PRESETS.map((p) => [p.text, p.value])).toEqual([
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

    test('an infinite value shows Infinity under any mask', () => {
        expect(applyFormat(Infinity, presetValue('Number')).m).toBe('Infinity');
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
});

// B1 holds the formula and A1 what it reads, so a test moves the result as a person does, by typing in A1.
function formulaUnder(formula: string, fa: string, a1 = 2) {
    const ctx = contextFactory({
        selections: selectionFactory([0, 0], [1, 1], 0, 1),
        editingCellPosition: [],
    }) as Context;
    const data = ctx.sheets[0].data;
    if (!data) throw new Error('no data');
    data[0][0] = { v: a1, m: String(a1), ct: { fa: 'General', t: 'n' } };
    updateCell(ctx, 0, 1, null, formula);
    updateFormat(ctx, cellInput, data, 'ct', fa);
    return { ctx, data, cell: () => data[0][1], type: (a: number) => updateCell(ctx, 0, 0, null, a) };
}

describe('a formula under a number format', () => {
    const NUMBER = '#,##0.00';

    test('a text result shows as text the moment the format lands, and the format stays', () => {
        const { cell } = formulaUnder('=IF(A1>1,"005",5)', NUMBER);
        expect(cell()?.m).toBe('005');
        expect(cell()?.ct).toEqual({ fa: NUMBER, t: 'g' });
    });

    test('it shows the same however the result got there', () => {
        const { cell, type } = formulaUnder('=IF(A1>1,"005",5)', NUMBER);
        type(3);
        expect(cell()?.m).toBe('005');
        type(1);
        expect(cell()?.m).toBe('5.00');
        expect(cell()?.ct).toEqual({ fa: NUMBER, t: 'n' });
        type(6);
        expect(cell()?.m).toBe('005');
        expect(cell()?.ct).toEqual({ fa: NUMBER, t: 'g' });
    });

    test('a text constant in a formula shows as text too', () => {
        expect(formulaUnder('="005"', NUMBER).cell()?.m).toBe('005');
    });

    test('a formula reading it reads text, not the number 5', () => {
        const { ctx, data, type } = formulaUnder('=IF(A1>1,"005",5)', NUMBER);
        updateCell(ctx, 0, 2, null, '=ISTEXT(B1)');
        expect(data[0][2]?.v).toBe(true);
        type(3);
        expect(data[0][2]?.v).toBe(true);
    });

    test('a number stays formatted', () => {
        for (const formula of ['=2+3', '=A1', '=IF(A1>1,5,"x")', '=VALUE("5")']) {
            const { cell } = formulaUnder(formula, NUMBER, 5);
            expect(cell()?.m).toBe('5.00');
            expect(cell()?.ct).toEqual({ fa: NUMBER, t: 'n' });
        }
    });

    test('a date format makes a date of a number and leaves text alone', () => {
        const date = formulaUnder('=DATE(2026,1,4)', 'dd/MM/yyyy').cell();
        expect(date?.ct?.t).toBe('d');
        expect(date?.m).toBe('04/01/2026');
        const text = formulaUnder('="005"', 'dd/MM/yyyy').cell();
        expect(text?.m).toBe('005');
        expect(text?.ct).toEqual({ fa: 'dd/MM/yyyy', t: 'g' });
    });

    test('an error and a boolean keep their own type and text', () => {
        const error = formulaUnder('=1/0', NUMBER).cell();
        expect(error?.m).toBe('#DIV/0!');
        expect(error?.ct?.t).toBe('e');
        const boolean = formulaUnder('=1>0', NUMBER).cell();
        expect(boolean?.m).toBe('TRUE');
        expect(boolean?.ct?.t).toBe('b');
    });

    test('a formula with no value shows nothing', () => {
        const { cell } = formulaUnder('=D4', NUMBER);
        expect(cell()?.f).toBe('=D4');
        expect(cell()?.m ?? '').not.toContain('undefined');
    });

    test('Plain text holds a number as text', () => {
        const { cell } = formulaUnder('=2+3', '@');
        expect(cell()?.m).toBe('5');
        expect(cell()?.ct).toEqual({ fa: '@', t: 's' });
    });
});
