import { describe, expect, test } from 'bun:test';
import { CALC, DIV0, errorOf, NA, REF, VALUE } from '../../index';
import { engineOf, evaluate, valueAt } from '../recalc/support';

const ALL = Number.POSITIVE_INFINITY;

describe('an operator over arrays answers what its elements answer one by one', () => {
    test('of two errors the left one is the answer, in every family of operators', () => {
        for (const op of ['+', '-', '*', '/', '^', '&', '=', '<>', '<', '>=']) {
            expect([op, evaluate(`=INDEX({#N/A;1}${op}{#DIV/0!;#REF!},1)`)]).toEqual([op, NA]);
            expect([op, evaluate(`=INDEX({#N/A;1}${op}{#DIV/0!;#REF!},2)`)]).toEqual([op, REF]);
            expect([op, evaluate(`=INDEX(A1:A2${op}B1:B2,1)`, { A1: NA, A2: 1, B1: DIV0, B2: REF })]).toEqual([op, NA]);
            expect([op, evaluate(`=INDEX(A1:A2${op}B1:B2,2)`, { A1: NA, A2: 1, B1: DIV0, B2: REF })]).toEqual([
                op,
                REF,
            ]);
        }
    });

    test('an error only a file knows goes through as itself, from a cell, a range and an array', () => {
        const cells = { A1: errorOf('#GETTING_DATA'), A2: 1, B1: 1, B2: DIV0 };
        const text = (value: unknown) => (typeof value === 'object' && value !== null ? JSON.stringify(value) : value);
        expect(text(evaluate('=INDEX(A1+B1:B2,2)', cells))).toContain('#GETTING_DATA');
        expect(text(evaluate('=INDEX(A1:A2+B1:B2,1)', cells))).toContain('#GETTING_DATA');
        expect(text(evaluate('=INDEX((A1:A2&"")=B1:B2,1)', cells))).toContain('#GETTING_DATA');
        expect(text(evaluate('=INDEX(B1:B2-(+A1:A2),1)', cells))).toContain('#GETTING_DATA');
        expect(evaluate('=INDEX(B1:B2-(+A1:A2),2)', cells)).toBe(DIV0);
    });

    test('a text on the left that is no number comes before an error on the right, in arithmetic only', () => {
        const cells = { A1: 'x', A2: 'x', B1: DIV0, B2: DIV0 };
        expect(evaluate('=INDEX(A1:A2*B1:B2,2)', cells)).toBe(VALUE);
        expect(evaluate('=INDEX(A1:A2&B1:B2,2)', cells)).toBe(DIV0);
        expect(evaluate('=INDEX(A1:A2=B1:B2,2)', cells)).toBe(DIV0);
        expect(evaluate('=INDEX({"x";"x"}*{#DIV/0!;#DIV/0!},2)')).toBe(VALUE);
    });

    test('an array shorter than the other is #N/A past its end, which is an error like any other', () => {
        expect(evaluate('=INDEX(A1:A3+B1:B2,3)', { A1: 1, A2: 2, A3: 3, B1: 1, B2: 1 })).toBe(NA);
        expect(evaluate('=INDEX(A1:A3+B1:B2,3)', { A1: 1, A2: 2, A3: DIV0, B1: 1, B2: 1 })).toBe(DIV0);
        expect(evaluate('=INDEX(B1:B2&A1:A3,3)', { A1: 1, A2: 2, A3: DIV0, B1: 1, B2: 1 })).toBe(NA);
        expect(evaluate('=INDEX(A1:C1+A2:B2,1,3)', { A1: 1, B1: 2, C1: 3, A2: 1, B2: 1 })).toBe(NA);
        expect(evaluate('=INDEX(A1:C1+A2:A3,2,3)', { A1: 1, B1: 2, C1: 3, A2: 10, A3: 20 })).toBe(23);
    });

    test('texts of cells compare by their keys: case never matters, and the order is the one of all texts', () => {
        const cells = { A1: 'straße', A2: 'co-op', A3: 'b', A4: 'Ab', B1: 'STRASSE', B2: 'coop', B3: 'B', B4: 'aB' };
        expect(evaluate('=SUMPRODUCT(--(A1:A4=B1:B4))', cells)).toBe(3);
        expect(evaluate('=SUMPRODUCT(--(A1:A4<>B1:B4))', cells)).toBe(1);
        expect(evaluate('=SUMPRODUCT(--(A1:A4>B1:B4))', cells)).toBe(1);
        expect(evaluate('=SUMPRODUCT(--(A1:A4<=B1:B4))', cells)).toBe(3);
        expect(evaluate('=SUMPRODUCT(--(A1:A4="AB"))', cells)).toBe(1);
        expect(evaluate('=SUMPRODUCT(--(A1:A4<"c"))', cells)).toBe(2);
        // A key no cell holds equals no cell, and still orders against every one.
        expect(evaluate('=SUMPRODUCT(--(A1:A4="zz"))', cells)).toBe(0);
        expect(evaluate('=SUMPRODUCT(--(A1:A4<>"zz"))', cells)).toBe(4);
        expect(evaluate('=SUMPRODUCT(--(A1:A4<"zz"))', cells)).toBe(4);
    });

    test('a blank cell is 0, an empty text and FALSE, and a text is never a number', () => {
        const cells = { A1: 0, A2: '', A3: false, A5: '1' };
        expect(evaluate('=SUMPRODUCT(--(A1:A5=A4))', cells)).toBe(4);
        expect(evaluate('=SUMPRODUCT(--(A1:A5=1))', cells)).toBe(0);
        expect(evaluate('=SUMPRODUCT(A1:A5+1)', cells)).toBe(6);
        expect(evaluate('=SUMPRODUCT(--(A1:A5&"x"="x"))', cells)).toBe(2);
    });

    test('a sign over a range makes values of its cells: a blank is 0, and a number is one a cell can hold', () => {
        const engine = engineOf({
            s1: {
                A1: 5e-324,
                A2: 'ab',
                C1: '=INDEX(+A1:A3,1)',
                C2: '=INDEX(-A1:A3,1)',
                C3: '=INDEX(+A1:A3,3)',
                C4: '=-A1',
            },
        });
        engine.recalc(ALL);
        expect(valueAt(engine, 'C1')).toBe(0);
        expect(Object.is(valueAt(engine, 'C2'), 0)).toBe(true);
        expect(valueAt(engine, 'C3')).toBe(0);
        // One value keeps a number too small for a cell, where an element of an array is made 0.
        expect(valueAt(engine, 'C4')).toBe(-5e-324);
        expect(evaluate('=INDEX(+A1:A2,1)', { A1: 'x'.repeat(40_000), A2: 1 })).toBe(VALUE);
        expect(evaluate('=LEN(INDEX(+A1:A2,1))', { A1: 'x'.repeat(32_767), A2: 1 })).toBe(32_767);
        expect(evaluate('=INDEX(A1:A2%,2)', { A1: 'x', A2: 50 })).toBe(0.5);
        expect(evaluate('=INDEX(-A1:A2,1)', { A1: true, A2: 50 })).toBe(-1);
        expect(evaluate('=INDEX(+A1:A2,1)', { A1: true, A2: 50 })).toBe(true);
    });

    test('the texts an operator makes count as work, and past the most a formula may do it is #CALC!', () => {
        const cells: Record<string, string | number> = { B1: 'x'.repeat(30_000) };
        for (let row = 1; row <= 5000; row += 1) cells[`A${row}`] = row;
        expect(evaluate('=LEN(INDEX(A1:A4000&B1,4000))', cells)).toBe(30_004);
        expect(evaluate('=LEN(INDEX(A1:A5000&B1,4000))', cells)).toBe(CALC);
        expect(evaluate('=LEN(INDEX(+A1:B5000,1,2))', cells)).toBe(30_000);
    });

    test('a range and the array of the answers each count their elements against the cap of a pass', () => {
        const cells: Record<string, string | number> = { C1: '=SUM(A1:A100*2)', C2: '=1+1' };
        for (let row = 1; row <= 100; row += 1) cells[`A${row}`] = row;
        // The first formula costs 1, the 100 cells of its range and the 100 elements it makes.
        const under = engineOf({ s1: cells });
        expect(under.recalc(202).stopped).toBe(false);
        const at = engineOf({ s1: cells });
        expect(at.recalc(201).stopped).toBe(true);
        expect(valueAt(at, 'C1')).toBe(10_100);
        expect(valueAt(at, 'C2')).toBe(null);
    });

    test('the cells of a range on the left are computed before the right operand is evaluated', () => {
        const engine = engineOf({ s1: { E1: '=SUM(A1:A2+C1:C2)', A1: '=1', A2: '=2', C1: '=3', C2: '=4' } });
        // E1 comes last in the pass, so each cell is computed as the pass reaches it. The second sheet reads first.
        const first = engineOf({
            s1: { A1: '=SUM(Sheet2!A1:A2+Sheet2!C1:C2)' },
            s2: { A1: '=1', A2: '=2', C1: '=3', C2: '=4' },
        });
        expect(engine.recalc(ALL).changed).toEqual([0, 0, 0, 1, 0, 2, 0, 1, 0, 4, 0, 0]);
        expect(first.recalc(ALL).changed).toEqual([1, 0, 0, 1, 1, 2, 0, 1, 0, 0, 0, 0]);
    });

    test('the references of two arrays are read element by element, the left one first', () => {
        const engine = engineOf({
            s1: { A1: '=SUM(OFFSET(Sheet2!A1,{0;1},0)+OFFSET(Sheet2!C1,{0;1},0))' },
            s2: { A1: '=1', A2: '=2', C1: '=3', C2: '=4' },
        });
        // A1, C1, A2, C2 of the second sheet, each a run of its own, then the formula.
        expect(engine.recalc(ALL).changed).toEqual([1, 0, 0, 0, 1, 2, 0, 0, 1, 0, 1, 1, 1, 2, 1, 1, 0, 0, 0, 0]);
        expect(valueAt(engine, 'A1')).toBe(10);
    });

    test('a range that holds the formula that reads it puts that formula on a loop', () => {
        const engine = engineOf({ s1: { A1: 1, A2: '=SUM(A1:A3*2)', A3: 3, B1: '=SUM(A1:A3=A2)' } });
        const { loops } = engine.recalc(ALL);
        expect(loops).toEqual([{ sheet: 's1', row: 1, column: 0 }]);
        expect(valueAt(engine, 'A2')).toBe(REF);
        expect(valueAt(engine, 'B1')).toBe(REF);
    });
});
