import { describe, expect, test } from 'bun:test';
import { Engine, errorOf, NA } from '../../index';
import { stored } from '../recalc/support';
import type { TestCell } from './support';
import { source } from './support';

const ALL = Number.POSITIVE_INFINITY;

describe('load', () => {
    test('every kind of value comes back as it went in', () => {
        const engine = new Engine([
            source('s1', [
                [0, 0, 1.5],
                [1, 0, 'text'],
                [2, 0, true],
                [3, 0, false],
                [4, 0, NA],
                [5, 0, ''],
                [6, 0, 7, '=R1C1+5.5'],
                [7, 0, errorOf('#BUSY!')],
            ]),
            source('s2', [[2, 1, 'other']]),
        ]);
        const read = () => [0, 1, 2, 3, 4, 5, 6].map((row) => engine.valueOf('s1', row, 0));
        expect(read()).toEqual([1.5, 'text', true, false, NA, '', 7]);
        expect(engine.valueOf('s1', 4, 0)).toBe(NA);
        expect(engine.valueOf('s1', 7, 0)).toMatchObject({ text: '#BUSY!' });
        expect(engine.valueOf('s1', 7, 0)).toBe(engine.valueOf('s1', 7, 0));
        expect(engine.valueOf('s2', 2, 1)).toBe('other');
        engine.recalc(ALL);
        expect(read()).toEqual([1.5, 'text', true, false, NA, '', 7]);
    });

    test('a read past a column, or past the sheet, is empty', () => {
        const engine = new Engine([source('s1', [[2, 0, 1]])]);
        expect(engine.valueOf('s1', 3, 0)).toBeNull();
        expect(engine.valueOf('s1', 1000000, 0)).toBeNull();
        expect(engine.valueOf('s1', 0, 5)).toBeNull();
    });

    test('a formula that came without a value is empty until a recalc computes it', () => {
        const engine = new Engine([
            source('s1', [
                [0, 0, null, '=1+1'],
                [1, 0, 5, '=1+1'],
            ]),
        ]);
        expect([engine.valueOf('s1', 0, 0), engine.valueOf('s1', 1, 0)]).toEqual([null, 5]);
        engine.recalc(ALL);
        expect([engine.valueOf('s1', 0, 0), engine.valueOf('s1', 1, 0)]).toEqual([2, 5]);
    });

    test('a cell reported empty leaves no trace, however far out it is', () => {
        const formulas = [
            '=A1:C3+D:F',
            '=SUM(A:F)',
            '=COUNTBLANK(D:F)',
            '=COUNTA(A:XFD)',
            '=MATCH(10,D:D,0)',
            '=XMATCH(10,D:D,0,-1)',
            '=XLOOKUP("",F:F,D:D,"none",0,-1)',
            '=COUNTIF(F:F,"")',
            '=SUM(--(E:E=""))',
            '=F1048576',
        ];
        const content: TestCell[] = [
            [0, 0, 1],
            [0, 3, 10],
            [2, 4, 'x'],
            ...formulas.map((formula, row): TestCell => [row, 9, null, stored(formula, `J${row + 1}`)]),
        ];
        const empties: TestCell[] = [
            [1048575, 5, null],
            [1048575, 16383, null],
            [700, 0, null],
            [5, 4, null],
            [40, 9, null],
        ];
        const plain = new Engine([source('s1', content)]);
        const padded = new Engine([source('s1', [...empties, ...content, ...empties])]);
        const read = (engine: Engine) => {
            const values = formulas.map((_, row) => engine.valueOf('s1', row, 9));
            for (const [row, column] of [...content, ...empties]) values.push(engine.valueOf('s1', row, column));
            return values;
        };
        expect(read(padded)).toEqual(read(plain));
        plain.recalc(ALL);
        padded.recalc(ALL);
        expect(read(padded)).toEqual(read(plain));
        for (const engine of [plain, padded]) engine.setValue('s1', 3, 3, 10);
        plain.recalc(ALL);
        padded.recalc(ALL);
        expect(read(padded)).toEqual(read(plain));
    });
});

describe('writes', () => {
    test('a write past the end of a column lands, and the rows between are empty', () => {
        const engine = new Engine([source('s1', [[9, 0, 1]])]);
        engine.setValue('s1', 10, 0, 2);
        engine.setValue('s1', 99, 0, 3);
        engine.setValue('s1', 3, 4, 'far');
        const read = () => [9, 10, 50, 99, 100].map((row) => engine.valueOf('s1', row, 0));
        expect(read()).toEqual([1, 2, null, 3, null]);
        expect([engine.valueOf('s1', 3, 4), engine.valueOf('s1', 3, 3)]).toEqual(['far', null]);
        engine.recalc(ALL);
        expect(read()).toEqual([1, 2, null, 3, null]);
    });

    test('a literal replaces a formula, a formula a literal, and a clear both', () => {
        const engine = new Engine([source('s1', [[0, 0, 5]])]);
        engine.setFormula('s1', 0, 0, '=1+1');
        expect(engine.valueOf('s1', 0, 0)).toBeNull();
        engine.recalc(ALL);
        expect(engine.valueOf('s1', 0, 0)).toBe(2);
        engine.setValue('s1', 0, 0, 'typed');
        expect(engine.valueOf('s1', 0, 0)).toBe('typed');
        engine.recalc(ALL);
        expect(engine.valueOf('s1', 0, 0)).toBe('typed');
        engine.setFormula('s1', 0, 0, '=1+1');
        engine.clear('s1', 0, 0);
        engine.clear('s1', 500, 9);
        engine.recalc(ALL);
        expect([engine.valueOf('s1', 0, 0), engine.valueOf('s1', 500, 9)]).toEqual([null, null]);
    });
});
