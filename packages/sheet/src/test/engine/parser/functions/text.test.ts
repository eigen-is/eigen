import { describe, expect, test } from 'bun:test';
import { createArrayResolver } from '../../../../engine/cell-resolver';
import { FormulaEngine } from '../../../../engine/formula-engine';
import type { Cell } from '../../../../engine/types';

function cell(v: number | string | boolean | null): Cell | null {
    if (v == null) return null;
    if (typeof v === 'boolean') return { v, ct: { t: 'b', fa: 'General' } };
    return typeof v === 'number' ? { v, ct: { t: 'n', fa: 'General' } } : { v, ct: { t: 's', fa: 'General' } };
}

function rows(values: (number | string | boolean | null)[][]): (Cell | null)[][] {
    return values.map((row) => row.map(cell));
}

// The tables of Microsoft's TEXTJOIN examples.
const resolver = createArrayResolver([
    {
        id: 's1',
        name: 'Currency',
        data: rows([
            ['US Dollar'],
            ['Australian Dollar'],
            ['Chinese Yuan'],
            ['Hong Kong Dollar'],
            ['Israeli Shekel'],
            ['South Korean Won'],
            ['Russian Ruble'],
        ]),
        calculationChain: [],
        dynamicArrayCompute: [],
    },
    {
        id: 's2',
        name: 'Pairs',
        data: rows([
            ['a1', 'b1'],
            ['a2', 'b2'],
            [null, null],
            ['a4', 'b4'],
            ['a5', 'b5'],
            ['a6', 'b6'],
            ['a7', 'b7'],
        ]),
        calculationChain: [],
        dynamicArrayCompute: [],
    },
    {
        id: 's3',
        name: 'Cities',
        data: rows([
            ['Tulsa', 'OK', '74133', 'US'],
            ['Seattle', 'WA', '98109', 'US'],
            ['Iselin', 'NJ', '08830', 'US'],
            ['Fort Lauderdale', 'FL', '33309', 'US'],
            ['Tempe', 'AZ', '85285', 'US'],
            ['end', null, null, null],
            [',', ',', ',', ';'],
            [1.5, true, 'x', null],
        ]),
        calculationChain: [],
        dynamicArrayCompute: [],
    },
]);

const engine = new FormulaEngine();
const value = (formula: string) => engine.evaluate(formula, 's1', resolver).value;

describe('TEXTJOIN', () => {
    test("Microsoft's examples: a range joins row by row, and ignore_empty drops the blank cells", () => {
        expect(value('=TEXTJOIN(", ",TRUE,A1:A7)')).toBe(
            'US Dollar, Australian Dollar, Chinese Yuan, Hong Kong Dollar, Israeli Shekel, South Korean Won, Russian Ruble',
        );
        expect(value('=TEXTJOIN(", ",TRUE,Pairs!A1:B7)')).toBe('a1, b1, a2, b2, a4, b4, a5, b5, a6, b6, a7, b7');
        expect(value('=TEXTJOIN(", ",FALSE,Pairs!A1:B7)')).toBe('a1, b1, a2, b2, , , a4, b4, a5, b5, a6, b6, a7, b7');
    });

    test('a delimiter range is used in turn, starting over at its end', () => {
        expect(value('=TEXTJOIN(Cities!A7:D7,TRUE,Cities!A1:D6)')).toBe(
            'Tulsa,OK,74133,US;Seattle,WA,98109,US;Iselin,NJ,08830,US;Fort Lauderdale,FL,33309,US;Tempe,AZ,85285,US;end',
        );
    });

    test('several text arguments, a number and a boolean read as their text', () => {
        expect(value('=TEXTJOIN("-",TRUE,"a",Cities!A8:D8,"b")')).toBe('a-1.5-TRUE-x-b');
        expect(value('=TEXTJOIN(0,1,"a","b")')).toBe('a0b');
        expect(value('=TEXTJOIN("",TRUE,"a","","b")')).toBe('ab');
        expect(value('=TEXTJOIN(",",FALSE,"a","","b")')).toBe('a,,b');
        expect(value('=textjoin("/",TRUE,DATE(2026,1,5))')).toBe('46027');
    });

    test('nothing to join is an empty text', () => {
        expect(value('=TEXTJOIN(",",TRUE,Pairs!A3:B3)')).toBe('');
    });

    test('a result over 32,767 characters is #VALUE!', () => {
        expect(value('=LEN(TEXTJOIN(",",TRUE,REPT("x",32767)))')).toBe(32767);
        expect(value('=TEXTJOIN(",",TRUE,REPT("x",32766),"y")')).toBe('#VALUE!');
    });

    test('an error argument propagates, text for ignore_empty is #VALUE!, no text argument #N/A', () => {
        expect(value('=TEXTJOIN(",",TRUE,"a",1/0)')).toBe('#DIV/0!');
        expect(value('=TEXTJOIN(1/0,TRUE,"a")')).toBe('#DIV/0!');
        expect(value('=TEXTJOIN(",","yes","a")')).toBe('#VALUE!');
        expect(value('=TEXTJOIN(",",TRUE)')).toBe('#N/A');
        expect(value('=IFERROR(TEXTJOIN(",",TRUE,1/0),"none")')).toBe('none');
    });
});
