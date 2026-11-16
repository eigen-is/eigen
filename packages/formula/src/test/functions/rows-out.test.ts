import { describe, expect, test } from 'bun:test';
import type { Literal } from '../../index';
import { DIV0 } from '../../index';
import type { Cells } from '../recalc/support';
import { engineOf, valueAt } from '../recalc/support';

// What SUBTOTAL and AGGREGATE leave out of the rows a sheet hides or filters. Row 2 is hidden by hand and row 4 is
// left out by a filter, as Excel batches 5 (check 7) and 6 (group 11) recorded each alone.

const DATA: Cells = {
    A1: 1,
    A2: 2,
    A3: 4,
    A4: 8,
    A5: 16,
    A6: 32,
    // An error on the hidden row, and one on the filtered row.
    B1: 1,
    B2: '=1/0',
    B3: 4,
    B4: 8,
    B5: 16,
    B6: 32,
    C1: 1,
    C2: 2,
    C3: 4,
    C4: '=1/0',
    C5: 16,
    C6: 32,
    // The largest on one of the two rows and the smallest on the other.
    D1: 1,
    D2: 64,
    D3: 4,
    D4: -8,
    D5: 16,
    D6: 32,
};

function answers(formulas: readonly string[], cells: Cells = DATA, hidden = [1, 1], filtered = [3, 3]) {
    const hosts = Object.fromEntries(formulas.map((formula, at) => [`N${at + 1}`, formula]));
    const engine = engineOf({ s1: { ...cells, ...hosts }, s2: { A1: 5, A2: 6, A3: 7 } });
    engine.setRowsOut('s1', hidden, filtered);
    engine.recalc(Number.POSITIVE_INFINITY);
    return formulas.map((_, at) => valueAt(engine, `N${at + 1}`));
}

const TARGETS = ['AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'PRODUCT', 'STDEV.S', 'STDEV.P', 'SUM', 'VAR.S', 'VAR.P'];

describe('SUBTOTAL leaves out the rows a filter left out, and from 101 on the rows hidden by hand too', () => {
    // Each code with row 2 hidden and row 4 filtered, and the other way around.
    test.each(TARGETS.map((target, at) => [at + 1, target] as const))(
        'code %i is %s without the filtered row',
        (code, target) => {
            const formulas = [`=SUBTOTAL(${code},D1:D6)`, `=${target}(D1:D3,D5:D6)`, `=${target}(D1,D3:D6)`];
            const [subtotal, withoutRow4] = answers(formulas);
            const [swapped, , withoutRow2] = answers(formulas, DATA, [3, 3], [1, 1]);
            expect([subtotal, swapped]).toEqual([withoutRow4, withoutRow2]);
        },
    );

    test.each(TARGETS.map((target, at) => [at + 101, target] as const))(
        'code %i is %s without the filtered and the hidden row',
        (code, target) => {
            const formulas = [`=SUBTOTAL(${code},D1:D6)`, `=${target}(D1,D3,D5:D6)`];
            const [subtotal, withoutBoth] = answers(formulas);
            const [onlyHidden, , withoutRow2] = answers([...formulas, `=${target}(D1,D3:D6)`], DATA, [1, 1], []);
            const [onlyFiltered] = answers(formulas, DATA, [], [1, 1]);
            expect([subtotal, onlyHidden, onlyFiltered]).toEqual([withoutBoth, withoutRow2, withoutRow2]);
        },
    );

    test.each<[string, Literal | null]>([
        // Batch 5: one hidden cell is 3 for 9 and 0 for 109 and 103.
        ['=SUBTOTAL(9,A2)', 2],
        ['=SUBTOTAL(109,A2)', 0],
        ['=SUBTOTAL(103,A2)', 0],
        ['=SUBTOTAL(9,A4)', 0],
        ['=SUBTOTAL(3,A4)', 0],
        ['=SUBTOTAL(3,A1:A6)', 5],
        ['=SUBTOTAL(103,A1:A6)', 4],
        // An error on a row that is left out is none.
        ['=SUBTOTAL(9,B1:B6)', DIV0],
        ['=SUBTOTAL(109,B1:B6)', 53],
        ['=SUBTOTAL(9,C1:C6)', 55],
        ['=SUBTOTAL(109,C2)', 0],
        ['=SUBTOTAL(9,C4)', 0],
        ['=SUBTOTAL(9,B2)', DIV0],
        // Every column of a range, every area, and a range that starts on a row left out.
        ['=SUBTOTAL(109,A1:C6)', 159],
        ['=SUBTOTAL(9,A1:A6,C1:C6)', 110],
        ['=SUBTOTAL(109,(A1:A2,A4:A5))', 17],
        ['=SUBTOTAL(109,A2:A6)', 52],
        ['=SUBTOTAL(109,A4:A6)', 48],
        ['=SUBTOTAL(109,A2:A4)', 4],
        // The rows of the sheet that is read count, not those of the sheet the formula is on.
        ['=SUBTOTAL(109,Sheet2!A1:A3)', 18],
        ['=SUM(A1:A6)', 63],
    ])('%s', (formula, expected) => {
        expect(answers([formula])[0]).toBe(expected);
    });

    test('the sheet that is read says which rows are left out, wherever the formula is', () => {
        const engine = engineOf({ s1: { A1: '=SUBTOTAL(109,Sheet2!A1:A3)', A2: 9 }, s2: { A1: 5, A2: 6, A3: 7 } });
        engine.setRowsOut('s1', [0, 2], []);
        engine.setRowsOut('s2', [1, 1], []);
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'A1')).toBe(12);
    });

    test('rows that are both hidden and filtered, the filtered ones inside the hidden, are left out once', () => {
        const formulas = ['=SUBTOTAL(109,A1:A6)', '=SUBTOTAL(9,A1:A6)', '=SUBTOTAL(109,A3)', '=AGGREGATE(9,5,A4:A6)'];
        expect(answers(formulas, DATA, [0, 4], [1, 2])).toEqual([32, 57, 0, 32]);
        expect(answers(formulas, DATA, [1, 2], [0, 4])).toEqual([32, 32, 0, 32]);
    });

    test('a nested SUBTOTAL on a row that shows is still passed over', () => {
        const cells = { ...DATA, A7: '=SUBTOTAL(109,A1:A6)' };
        expect(answers(['=SUBTOTAL(109,A1:A7)', '=SUBTOTAL(9,A1:A7)'], cells)).toEqual([53, 55]);
    });

    // More rows than the walk gathers at once, with runs that cross where it stops and goes on.
    test.each([[1], [2], [3]])(
        'a range of 5,000 rows and %i columns with 800 hidden and 490 filtered runs',
        (columns) => {
            const cells: Record<string, number> = {};
            const hidden: number[] = [];
            const filtered: number[] = [];
            let shown = 0;
            let unfiltered = 0;
            for (let row = 0; row < 5000; row += 1) {
                const isHidden = row % 6 < 2 && row < 4800;
                const isFiltered = row % 10 > 6 && row >= 100;
                if (row % 6 === 0 && row < 4800) hidden.push(row, row + 1);
                if (row % 10 === 7 && row >= 100) filtered.push(row, row + 2);
                for (let c = 0; c < columns; c += 1) {
                    cells[`${'ABC'[c]}${row + 1}`] = row + c;
                    if (!isFiltered) unfiltered += row + c;
                    if (!isFiltered && !isHidden) shown += row + c;
                }
            }
            const last = 'ABC'[columns - 1];
            expect(hidden.length + filtered.length).toBe(2 * 800 + 2 * 490);
            expect(
                answers([`=SUBTOTAL(9,A1:${last}5000)`, `=SUBTOTAL(109,A1:${last}5000)`], cells, hidden, filtered),
            ).toEqual([unfiltered, shown]);
        },
    );
});

describe('AGGREGATE leaves out hidden and filtered rows for the options that say hidden rows', () => {
    test.each<[number, number, Literal]>([
        [0, 63, DIV0],
        [1, 53, 53],
        [2, 63, 61],
        [3, 53, 53],
        [4, 63, DIV0],
        [5, 53, 53],
        [6, 63, 61],
        [7, 53, 53],
    ])('option %i of a sum is %i, and over an error on the hidden row %p', (option, sum, overError) => {
        expect(answers([`=AGGREGATE(9,${option},A1:A6)`, `=AGGREGATE(9,${option},B1:B6)`])).toEqual([sum, overError]);
    });

    test.each<[string, Literal]>([
        // Batch 5: option 5 keeps an error on a row that shows.
        ['=AGGREGATE(9,5,B1:B6,C1:C6)', 53 + 53],
        ['=AGGREGATE(9,4,C1:C6)', DIV0],
        ['=AGGREGATE(9,6,C1:C6)', 55],
        // The functions that take a second number read the same rows.
        ['=AGGREGATE(14,5,A1:A6,2)', 16],
        ['=AGGREGATE(15,5,A1:A6,2)', 4],
        ['=AGGREGATE(15,4,A1:A6,2)', 2],
        ['=AGGREGATE(12,5,A1:A6)', 10],
        ['=AGGREGATE(12,4,A1:A6)', 6],
        ['=AGGREGATE(3,1,A1:A6)', 4],
        ['=AGGREGATE(9,5,A2)', 0],
        ['=AGGREGATE(9,4,A2)', 2],
        // An array has no rows of a sheet.
        ['=AGGREGATE(14,5,A1:A6*1,1)', 32],
        ['=AGGREGATE(14,5,A1:A6*1,5)', 2],
    ])('%s', (formula, expected) => {
        expect(answers([formula])[0]).toBe(expected);
    });
});
