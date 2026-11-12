import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import { DIV0, errorOf, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';
import { F1 } from './collectors.test';

// The sheet of Excel batch 5, check 7: A1:A5 = 1..5, C1 = 1, C2 = 2, and a subtotal of those two in C4.
const SUB: Cells = { A1: 1, A2: 2, A3: 3, A4: 4, A5: 5, C1: 1, C2: 2, C4: '=SUBTOTAL(9,C1:C2)', E1: 1, E2: '=1/0' };

function across(formula: string, count: number, cells: Cells) {
    return Array.from({ length: count }, (_, at) => evaluate(`=INDEX(${formula.slice(1)},1,${at + 1})`, cells));
}

describe('SUBTOTAL picks a function by its first argument and hands it the references that follow', () => {
    test.each([
        ['=SUBTOTAL(9,A1:A5)', 15],
        ['=SUBTOTAL(1,A1:A5)', 3],
        ['=SUBTOTAL(2,A1:A5)', 5],
        ['=SUBTOTAL(3,A1:A5)', 5],
        ['=SUBTOTAL(4,A1:A5)', 5],
        ['=SUBTOTAL(5,A1:A5)', 1],
        ['=SUBTOTAL(9,A3)', 3],
        ['=SUBTOTAL(9.9,A1:A5)', 15],
        // Batch 5: an area written twice counts twice.
        ['=SUBTOTAL(9,A1:A5,A1:A5)', 30],
        ['=SUBTOTAL(9,(A1:A2,A4:A5))', 12],
        // Batch 5: a cell whose formula holds a SUBTOTAL is passed over, where SUM adds it.
        ['=SUBTOTAL(9,C1:C4)', 3],
        ['=SUM(C1:C4)', 6],
        ['=SUBTOTAL(9,C4)', 0],
        ['=SUBTOTAL(3,C1:C4)', 2],
        ['=SUBTOTAL(9,C1:C4,C1:D4)', 6],
        // No row is hidden in this build, so 101 to 111 answer as 1 to 11 do.
        ['=SUBTOTAL(109,A1:A5)', 15],
        ['=SUBTOTAL(103,A1:A5)', 5],
        ['=SUBTOTAL(109,C1:C4)', 3],
        // A code that picks no function, and one whose function this build does not have.
        ['=SUBTOTAL(12,A1:A5)', VALUE],
        ['=SUBTOTAL(0,A1:A5)', VALUE],
        ['=SUBTOTAL(6,A1:A5)', errorOf('#NAME?')],
        ['=SUBTOTAL(9)', VALUE],
        ['=SUBTOTAL("x",A1:A5)', VALUE],
        ['=SUBTOTAL(1/0,A1:A5)', DIV0],
        // Only a reference is taken: Excel refuses these when they are entered, and here they are an error.
        ['=SUBTOTAL(9,{1,2})', VALUE],
        ['=SUBTOTAL(9,A1:A3*1)', VALUE],
        ['=SUBTOTAL(9,5)', VALUE],
        ['=SUBTOTAL(9,A1:A5,)', VALUE],
        ['=SUBTOTAL(9,1/0)', DIV0],
        ['=SUBTOTAL(9,E1:E2)', DIV0],
        ['=SUBTOTAL(2,E1:E2)', 1],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, SUB)).toBe(expected);
    });

    // Batch 5: A11 holds a SUBTOTAL with +0 around it, and the outer one still passes it over.
    test('a SUBTOTAL anywhere in a formula hides its cell from an outer one', () => {
        const cells = { ...F1, A11: '=SUBTOTAL(9,A1:A10)+0' };
        expect(evaluate('=SUBTOTAL(9,A1:A12)', cells)).toBe(550);
        expect(evaluate('=SUM(A1:A12)', cells)).toBe(1100);
        expect(evaluate('=SUBTOTAL(9,A1:A12)', { ...F1, A11: '=IF(TRUE,SUBTOTAL(9,A1:A10))' })).toBe(550);
    });

    // The ruling on nested SUBTOTALs, for a passed-over cell that holds an error; Excel's own answer is queued.
    test.each([
        ['=SUBTOTAL(9,G1:G5)', 35],
        ['=SUBTOTAL(1,G1:G5)', 35 / 3],
        ['=SUBTOTAL(4,G1:H5)', 20],
        ['=SUBTOTAL(9,H1:H3)', 3],
        ['=SUBTOTAL(9,H2)', 0],
        ['=SUBTOTAL(9,G1:G4,H1:H3)', 38],
        ['=SUBTOTAL(9,(G1:G5,H1:H3))', 38],
        ['=SUBTOTAL(9,G1:G6)', DIV0],
        ['=SUM(G1:G5)', DIV0],
    ])('an error in a cell that an outer SUBTOTAL passes over is passed over too: %s', (formula, expected) => {
        const cells = {
            G1: 10,
            G2: 20,
            G4: 5,
            G5: '=SUBTOTAL(1,Y1:Y2)',
            G6: '=1/0',
            H1: 1,
            H2: '=SUBTOTAL(9,H1)/0',
            H3: 2,
        };
        expect(evaluate(formula, cells)).toBe(expected);
    });

    test('a function in the range of a SUBTOTAL still adds the cells that the SUBTOTAL passes over', () => {
        expect(evaluate('=SUBTOTAL(9,C1:C5)', { ...SUB, C5: '=SUM(C1:C4)' })).toBe(9);
        expect(evaluate('=SUBTOTAL(9,C1:C2)+SUM(C1:C4)', SUB, 'F1')).toBe(9);
    });

    test.each([
        // Batch 5: the code runs the call once per element, and so does an array of references.
        ['=SUBTOTAL({1,9},A1:A3)', [20, 60], F1],
        ['=SUBTOTAL(9,OFFSET(A1,{0,1,2},0,2))', [30, 50, 70], F1],
        ['=SUBTOTAL({9,12},A1:A3)', [60, VALUE], F1],
        ['=SUBTOTAL(9,OFFSET(C1,{0,3},0,1))', [1, 0], SUB],
    ])('%s', (formula, expected, cells) => {
        expect(across(formula, expected.length, cells)).toEqual(expected);
    });

    test('every function a code can pick takes every value of all its arguments, as one parameter', () => {
        const picks = FUNCTIONS.get('SUBTOTAL')?.chosen ?? new Map();
        expect([...picks.keys()].sort((a, b) => a - b)).toEqual(
            [...Array(11).keys()].flatMap((at) => [at + 1]).concat([...Array(11).keys()].map((at) => at + 101)),
        );
        for (const { target } of picks.values()) {
            const entry = FUNCTIONS.get(target);
            if (entry === undefined) continue;
            expect(entry.params.length).toBe(1);
            expect(entry.params[0].rest && entry.params[0].family !== null).toBe(true);
        }
    });
});
