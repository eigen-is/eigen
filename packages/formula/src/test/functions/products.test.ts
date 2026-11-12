import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import { fn, PRODUCTS, rest } from '../../functions/registry';
import { DIV0, NA, NUM, VALUE } from '../../index';
import { Recalc } from '../../recalc/recalc';
import { Workbook } from '../../store/workbook';
import type { Cells } from '../recalc/support';
import { engineOf, evaluate, evaluateWith, stored, valueAt, valuesWith } from '../recalc/support';

// Excel batch 3, sheet b3_e: A1:A3 = 1, #DIV/0!, 3, B1:B3 = #N/A, 2, 3, C1:C3 = 10, 20, 30.
const E: Cells = { A1: 1, A2: '=1/0', A3: 3, B1: '=NA()', B2: 2, B3: 3, C1: 10, C2: 20, C3: 30 };

describe('SUMPRODUCT: any argument’s error in argument order, then the sizes, then the products', () => {
    test.each([
        ['=SUMPRODUCT(A1:A3,B1:B3)', DIV0],
        ['=SUMPRODUCT(B1:B3,A1:A3)', NA],
        ['=SUMPRODUCT(B1:B3,C1:C2)', NA],
        ['=SUMPRODUCT(C1:C3,B1:B2)', NA],
        ['=SUMPRODUCT(B1:B3,2)', NA],
        ['=SUMPRODUCT(C1:C3,B2:B3)', VALUE],
        ['=SUMPRODUCT(C1:C3,2)', VALUE],
        ['=SUMPRODUCT(C1:C3,"2")', VALUE],
        ['=SUMPRODUCT(C1:C3,NA())', NA],
        ['=SUMPRODUCT(NA(),A1:A3)', NA],
        ['=SUMPRODUCT("2",3)', 0],
        ['=SUMPRODUCT(2,3)', 6],
        ['=SUMPRODUCT((C1:C3,B2:B3))', VALUE],
        ['=SUMPRODUCT(C1:C3,C1:C3)', 1400],
        ['=SUMPRODUCT(INDEX(C1:C3,{1,2,3}))', 0],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, E)).toBe(expected);
    });
});

describe('no collector hands the adder a number that is none', () => {
    // A product that overflows is #NUM! where it is made: this formula over all 16,384 columns ran for a minute.
    test('products of 1E200 that overflow are #NUM! at once', () => {
        const formula = '=SUMPRODUCT(Sheet2!A:CV*1,Sheet2!A:CV*1,Sheet2!A:CV*-1)';
        const engine = engineOf({
            s1: { A1: formula, A2: '=SUMPRODUCT(Sheet2!A1:A2,Sheet2!A1:A2,Sheet2!A1:A2)' },
            s2: { A1: 1e200, A2: -1e200 },
        });
        const started = performance.now();
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'A1')).toBe(NUM);
        expect(valueAt(engine, 'A2')).toBe(NUM);
        expect(performance.now() - started).toBeLessThan(2000);
    });

    test.each([
        ['=SUM((B:B="")*1E308)', NUM],
        ['=SUM(A:CV*1E108)', 0],
        ['=AVERAGE((B:B="")*1E308)', NUM],
        ['=AVERAGE(A:CV*1E108)', 0],
        ['=MAX(A:CV*1E108)', 1e308],
        ['=MIN(A:CV*1E108)', -1e308],
        ['=COUNT(A:CV*1E108)', 104857600],
        ['=COUNTA(A:CV*1E108)', 104857600],
        ['=AND(A:CV*1E108)', false],
        ['=OR(A:A*1E108)', true],
        ['=SUMIF(A1:A2,"<>x")', 0],
        ['=SUM(A1:A2*1E200)', NUM],
    ])('%s', (formula, expected) => {
        const started = performance.now();
        expect(evaluate(formula, { A1: 1e200, A2: -1e200 }, 'DA1')).toBe(expected);
        expect(performance.now() - started).toBeLessThan(2000);
    });
});

// Excel batch 6, sheet b6_ovf: A1:A2 = B1:B2 = 1E200, C1:C2 = 1E200, -1E200, F1 = 0, G1 = x, H1 = TRUE.
const OVERFLOW: Cells = { A1: 1e200, A2: 1e200, B1: 1e200, B2: 1e200, C1: 1e200, C2: -1e200, F1: 0, G1: 'x', H1: true };

describe('SUMPRODUCT multiplies one place factor by factor in written order, and an overflow on the way is #NUM!', () => {
    test.each([
        ['=SUMPRODUCT(A1:A2*1,B1:B2*1,C1:C2*-1)', NUM],
        ['=SUMPRODUCT(A1:A2,B1:B2,C1:C2)', NUM],
        ['=SUMPRODUCT(A1:A2,B1:B2,F1:F2)', NUM],
        ['=SUMPRODUCT(F1:F2,A1:A2,B1:B2)', 0],
        ['=SUMPRODUCT(A1,B1,F1)', NUM],
        ['=SUMPRODUCT(F1,A1,B1)', 0],
        ['=SUMPRODUCT(A1:A2,B1:B2,G1:G2)', NUM],
        ['=SUMPRODUCT(G1:G2,A1:A2,B1:B2)', 0],
        ['=SUMPRODUCT(A1,B1,G1)', NUM],
        ['=SUMPRODUCT(G1,A1,B1)', 0],
        ['=SUMPRODUCT(A1:A2,B1:B2,H1:H2)', NUM],
        ['=SUMPRODUCT(H1:H2,A1:A2,B1:B2)', 0],
        ['=SUMPRODUCT(A1,B1,H1)', NUM],
        ['=SUMPRODUCT(H1,A1,B1)', 0],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, OVERFLOW)).toBe(expected);
    });

    // The same rule where the 0 is a place under the last cell of its column, or in a column with no cell: K1:K2
    // and L1:L2 are 1, 1E200, M1 is 1, and Z holds nothing.
    const under: Cells = { K1: 1, K2: 1e200, L1: 1, L2: 1e200, M1: 1 };
    test.each([
        ['=SUMPRODUCT(K1:K2,L1:L2,M1:M2)', NUM],
        ['=SUMPRODUCT(K1:K2,L1:L2,Z1:Z2)', NUM],
        ['=SUMPRODUCT(K1:K2,L1:L2,XFA1:XFA2)', NUM],
        ['=SUMPRODUCT(M1:M2,K1:K2,L1:L2)', 1],
        ['=SUMPRODUCT(K1:K2,M1:M2,L1:L2)', 1],
        ['=SUMPRODUCT(Z1:Z2,K1:K2,L1:L2)', 0],
        ['=SUMPRODUCT(K1:K2*1,L1:L2,M1:M2)', NUM],
        ['=SUMPRODUCT(K1:K2,L1:L2*1,M1:M2)', NUM],
        ['=SUMPRODUCT(K1:K2*1,L1:L2*1,M1:M2)', NUM],
        ['=SUMPRODUCT(K1:K2*1,L1:L2*1,Z1:Z2)', NUM],
        ['=SUMPRODUCT(K1:K2*1,L1:L2*1,M1:M2*1)', NUM],
        ['=SUMPRODUCT(K1:K2*1,M1:M2,L1:L2*1)', 1],
        ['=SUMPRODUCT(M1:M2,K1:K2*1,L1:L2*1)', 1],
        ['=SUMPRODUCT(K:K,L:L,M:M)', NUM],
        ['=SUMPRODUCT(M:M,K:K,L:L)', 1],
        ['=SUMPRODUCT(K:K*1,L:L*1,M:M)', NUM],
        ['=SUMPRODUCT(K1:L2,K1:L2,M1:N2)', NUM],
        ['=SUMPRODUCT(M1:N2,K1:L2,K1:L2)', 1],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, under, 'P1')).toBe(expected);
    });
});

describe('the products are multiplied in written order and added row by row', () => {
    // (0.1 × 0.1) × 0.3 and (0.3 × 0.1) × 0.1 differ in their last bit.
    const cells: Cells = { A1: 0.1, A2: 0, B1: 0.1, B2: 0, C1: 0.3, C2: 0 };
    test.each([
        ['=SUMPRODUCT(A1:A2,B1:B2,C1:C2)', 0.1 * 0.1 * 0.3],
        ['=SUMPRODUCT(C1:C2,B1:B2,A1:A2)', 0.3 * 0.1 * 0.1],
        ['=SUMPRODUCT(A1:A2*1,B1:B2*1,C1:C2*1)', 0.1 * 0.1 * 0.3],
        ['=SUMPRODUCT(C1:C2*1,B1:B2*1,A1:A2*1)', 0.3 * 0.1 * 0.1],
        ['=SUMPRODUCT(C1:C2*1,B1:B2,A1:A2)', 0.3 * 0.1 * 0.1],
        ['=SUMPRODUCT(C1:C2,B1:B2*1,A1:A2)', 0.3 * 0.1 * 0.1],
        ['=SUMPRODUCT(C1:C2,B1:B2,A1:A2*1)', 0.3 * 0.1 * 0.1],
        ['=SUMPRODUCT(A1,B1,C1)', 0.1 * 0.1 * 0.3],
        ['=SUMPRODUCT(C1,B1,A1)', 0.3 * 0.1 * 0.1],
        ['=SUMPRODUCT(0.1,0.1,0.3)', 0.1 * 0.1 * 0.3],
        ['=SUMPRODUCT(0.3,0.1,0.1)', 0.3 * 0.1 * 0.1],
    ])('%s', (formula, expected) => {
        expect(0.1 * 0.1 * 0.3).not.toBe(0.3 * 0.1 * 0.1);
        expect(evaluate(formula, cells)).toBe(expected);
    });

    test('a table is added row by row, whatever its columns hold', () => {
        // Down the columns first, 1E16 + 1 + 1 loses both ones, and row by row 1 + 1 + 1E16 keeps them.
        const table: Cells = { A1: 1, B1: 1, A2: 1e16, B2: 0, C1: 1, D1: 1, C2: 1, D2: 1 };
        expect(evaluate('=SUMPRODUCT(A1:B2,C1:D2)', table)).toBe(1e16 + 2);
        expect(evaluate('=SUMPRODUCT(A1:B2*1,C1:D2)', table)).toBe(1e16 + 2);
    });
});

// Rows of the wrapper's own that say what a body is handed: the largest product, and how many places there are.
const MOST = fn('MOST', [rest(PRODUCTS)], (products) => products.max());
const PLACES = fn('PLACES', [rest(PRODUCTS)], (products) => products.count());

describe('products are made of the cells that exist', () => {
    const columns: Record<string, number> = {};
    for (let row = 1; row <= 3000; row += 1) {
        columns[`A${row}`] = -row;
        columns[`B${row}`] = row;
    }

    // Past the last cell of both columns every product is 0, and a 0 that was made would be the largest here.
    test.each([
        ['=MOST(A1:A3000,B1:B3000)', -1],
        ['=MOST(A1:A60000,B1:B60000)', -1],
        ['=MOST(A:A,B:B)', -1],
        ['=MOST(A2001:A60000,B2001:B60000)', -2001 * 2001],
        ['=MOST(A2001:A60000,B1:B58000)', -2001],
        ['=MOST(A1:A60000,B2001:B62000)', -2001],
        ['=MOST(A1:A60000,B2001:B62000,B1:B60000)', -2001],
        ['=MOST(A:A*1,B:B)', -1],
        ['=MOST(A:A,B:B*1)', -1],
    ])('%s makes no product under the columns', (formula, expected) => {
        expect(evaluateWith([MOST], formula, columns)).toBe(expected);
    });

    // A body that only looks at the products never sees one that is no number: the walk stops there.
    test.each([
        ['=MOST(A1:A2,B1:B2,C1:C2)', { A1: 1e200, B1: 1e200, C1: 0, A2: 1, B2: 1, C2: 1 }],
        ['=MOST(A1:A2,B1:B2,C1:C2)', { A1: 1e200, B1: -1e200, C1: 1, A2: 1, B2: 1, C2: 1 }],
        ['=MOST(A1:A2*1,B1:B2*1,C1:C2*1)', { A1: 1e200, B1: -1e200, C1: 1, A2: 1, B2: 1, C2: 1 }],
        ['=MOST(A1,B1,C1)', { A1: -1e200, B1: 1e200, C1: 0 }],
    ])('%s with a product that is no number is #NUM!', (formula, cells) => {
        expect(evaluateWith([MOST], formula, cells)).toBe(NUM);
    });

    test('the places of a call are those of its ranges, whatever cells they hold', () => {
        expect(
            valuesWith([PLACES], { ...columns, N1: '=PLACES(A:B,A:B)', N2: '=PLACES(A1:A9,B1:B9)' }, ['N1', 'N2']),
        ).toEqual([2 * 1048576, 9]);
    });

    test('two cells far apart cost their own columns: the pass has made nothing for them', () => {
        const formula = '=SUMPRODUCT(Sheet2!A:P,Sheet2!A:P)';
        const engine = engineOf({ s1: { A1: formula, A2: '=1+1', A3: '=2+2' }, s2: { A1048576: 3, P1: 4 } });
        // A formula that made a block of 16 columns by 1,048,576 rows alone spent what three formulas may.
        expect(engine.recalc(3).stopped).toBe(false);
        expect([valueAt(engine, 'A1'), valueAt(engine, 'A2'), valueAt(engine, 'A3')]).toEqual([25, 2, 4]);
    });

    test('a column that every range reaches far down beside thousands that end at once', () => {
        const wide: Cells = { A1048576: 3, AAA1: 4, B1: 2, B2: 5 };
        const engine = engineOf({ s1: { A1: '=SUMPRODUCT(Sheet2!A:XFD,Sheet2!A:XFD)' }, s2: wide });
        const started = performance.now();
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'A1')).toBe(9 + 16 + 4 + 25);
        expect(performance.now() - started).toBeLessThan(2000);
    });
});

describe('a walk of products that ends early leaves the next one right', () => {
    const cells: Record<string, number | string> = {};
    for (let row = 1; row <= 5000; row += 1) {
        cells[`A${row}`] = row === 4000 ? 1e200 : 1;
        cells[`B${row}`] = row === 4000 ? 1e200 : 2;
        cells[`C${row}`] = 3;
    }

    test('an overflow thousands of rows down, then the same columns without it', () => {
        const engine = engineOf({
            s1: {
                ...cells,
                N1: '=SUMPRODUCT(A:A,B:B)',
                N2: '=SUMPRODUCT(A1:A3999,B1:B3999)',
                N3: '=SUMPRODUCT(B:C,B:C)',
            },
        });
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'N1')).toBe(NUM);
        expect(valueAt(engine, 'N2')).toBe(2 * 3999);
        expect(valueAt(engine, 'N3')).toBe(NUM);
        engine.setValue('s1', 3999, 0, 1);
        engine.setValue('s1', 3999, 1, 2);
        engine.recalc(Number.POSITIVE_INFINITY);
        expect([valueAt(engine, 'N1'), valueAt(engine, 'N3')]).toEqual([2 * 5000, (4 + 9) * 5000]);
    });

    test('a body that throws between two walks, then a recalc that computes them all', () => {
        let fail = true;
        const thrower = fn('THROWER', [rest(PRODUCTS)], (products) => {
            const most = products.max();
            if (fail) throw new Error('a body that throws');
            return most;
        });
        const workbook = new Workbook([
            {
                id: 's1',
                name: 'Sheet1',
                cells: (cell) => {
                    for (let row = 0; row < 3000; row += 1) cell(row, 0, row + 1, null);
                    for (let row = 0; row < 2000; row += 1) cell(row, 1, 2, null);
                    cell(0, 13, null, stored('=THROWER(A:A,B:B)+SUMPRODUCT(A:A,B:B)', 'N1'));
                    cell(1, 13, null, stored('=SUMPRODUCT(B:B,A:A)+THROWER(A1:B10,A1:B10)', 'N2'));
                },
            },
        ]);
        const recalc = new Recalc(workbook, new Map([...FUNCTIONS, [thrower.name, thrower]]));
        expect(() => recalc.pass(Number.POSITIVE_INFINITY)).toThrow('a body that throws');
        fail = false;
        recalc.pass(Number.POSITIVE_INFINITY);
        const { columns } = workbook.sheets[0];
        expect([workbook.value(columns[13], 0), workbook.value(columns[13], 1)]).toEqual([
            4000 + 4002000,
            4002000 + 100,
        ]);
    });
});
