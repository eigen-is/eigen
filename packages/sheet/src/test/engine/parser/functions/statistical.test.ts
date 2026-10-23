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

// A: grade, B: weight (Microsoft's MAXIFS and MINIFS example), C: class, D: score with text and a boolean,
// E: one bit per row, so a SUMIFS over it names the rows it matched.
const resolver = createArrayResolver([
    {
        id: 's1',
        name: 'Sheet1',
        data: rows([
            [89, 1, 'a', 10, 1],
            [93, 2, 'b', 'n/a', 2],
            [96, 2, 'a', 30, 4],
            [85, 3, 'B', true, 8],
            [91, 1, 'a', 50, 16],
            [88, 1, null, 60, 32],
        ]),
        calculationChain: [],
        dynamicArrayCompute: [],
    },
]);

const engine = new FormulaEngine();
const value = (formula: string) => engine.evaluate(formula, 's1', resolver).value;

describe('MAXIFS and MINIFS', () => {
    test("Microsoft's examples: the largest and smallest grade of weight 1", () => {
        expect(value('=MAXIFS(A1:A6,B1:B6,1)')).toBe(91);
        expect(value('=MINIFS(A1:A6,B1:B6,1)')).toBe(88);
    });

    test('every criterion must hold, comparison criteria included', () => {
        expect(value('=MAXIFS(A1:A6,B1:B6,">1",C1:C6,"a")')).toBe(96);
        expect(value('=MINIFS(A1:A6,B1:B6,"<>2",B1:B6,"<3")')).toBe(88);
        expect(value('=maxifs(A1:A6,C1:C6,"*")')).toBe(96);
    });

    test('only numbers in the range count, so text and booleans are skipped', () => {
        expect(value('=MAXIFS(D1:D6,B1:B6,">0")')).toBe(60);
        expect(value('=MINIFS(D1:D6,C1:C6,"<>a")')).toBe(60);
    });

    test('no match is 0', () => {
        expect(value('=MAXIFS(A1:A6,B1:B6,9)')).toBe(0);
        expect(value('=MINIFS(A1:A6,C1:C6,"z")')).toBe(0);
    });

    test('a criteria range of another size or shape is #VALUE!', () => {
        expect(value('=MAXIFS(A1:A6,B1:B5,1)')).toBe('#VALUE!');
        expect(value('=MINIFS(A1:A4,B1:C4,1)')).toBe('#VALUE!');
    });

    test('a criteria range without its criterion is #N/A, an error criterion propagates', () => {
        expect(value('=MAXIFS(A1:A6,B1:B6)')).toBe('#N/A');
        expect(value('=MAXIFS(A1:A6,B1:B6,1/0)')).toBe('#DIV/0!');
    });

    test('a criterion matches exactly the cells SUMIFS sums', () => {
        for (const criterion of ['"a"', '"A"', '"<>a"', '">1"', '"=2"', '1', '"*"', '"b"', '"z"']) {
            for (const range of ['B1:B6', 'C1:C6']) {
                const matched = Number(value(`=SUMIFS(E1:E6,${range},${criterion})`));
                expect(value(`=MAXIFS(E1:E6,${range},${criterion})`)).toBe(
                    matched && 2 ** Math.floor(Math.log2(matched)),
                );
                expect(value(`=MINIFS(E1:E6,${range},${criterion})`)).toBe(matched & -matched);
            }
        }
    });
});
