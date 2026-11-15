import { expect, test } from 'bun:test';
import { at, engineOf } from '../recalc/support';
import type { Model } from './operator-model';
import { dataOf, diceOf, operationOf, placesOf } from './operator-model';

// A long run by hand: OPERATOR_LAW_SEED=7 OPERATOR_LAW_COUNT=50000 bun test ./src/test/eval/operator-law.test.ts
const SEED = Number(process.env['OPERATOR_LAW_SEED'] ?? 1);
const COUNT = Number(process.env['OPERATOR_LAW_COUNT'] ?? 8000);

const ALL = Number.POSITIVE_INFINITY;
// How many operations one workbook holds.
const PER_BOOK = 4;

function probeLabel(index: number): string {
    return `A${index + 1}`;
}

test('every operator over every kind and shape of operand equals the scalar operator, element by element', () => {
    const covered = new Map<string, number>();
    let elements = 0;
    for (let book = 0; book < COUNT / PER_BOOK; book += 1) {
        const dice = diceOf(SEED * 1_000_003 + book);
        const data = dataOf(dice);
        const probes: Record<string, string> = {};
        const expected: { readonly model: Model; readonly row: number; readonly column: number }[] = [];
        for (let k = 0; k < PER_BOOK; k += 1) {
            const model = operationOf(dice);
            for (const mark of model.marks) covered.set(mark, (covered.get(mark) ?? 0) + 1);
            for (const [row, column] of placesOf(dice, model)) {
                probes[probeLabel(expected.length)] = `=INDEX(${model.text},${row + 1},${column + 1})`;
                expected.push({ model, row, column });
            }
        }
        // The probes sit on the first sheet, so the first of them meets the data's formulas still to be computed.
        const engine = engineOf({ s1: probes, data });
        const { loops } = engine.recalc(ALL);
        covered.set('cells on a loop', (covered.get('cells on a loop') ?? 0) + loops.length);
        const read = (row: number, column: number) => engine.valueOf('data', row, column);
        for (let index = 0; index < expected.length; index += 1) {
            const { model, row, column } = expected[index];
            const [r, c] = at(probeLabel(index));
            const actual = engine.valueOf('s1', r, c);
            const wanted = model.at(read, row, column);
            if (!Object.is(actual, wanted)) {
                const shown = (value: unknown) => (typeof value === 'object' ? JSON.stringify(value) : String(value));
                throw new Error(
                    `book ${book}: ${probes[probeLabel(index)]} is ${shown(actual)}, the definition says ${shown(wanted)}; data ${JSON.stringify(data)}`,
                );
            }
            elements += 1;
        }
    }
    console.log(`${COUNT} operations, ${elements} elements`, JSON.stringify(Object.fromEntries(covered)));
    for (const mark of [
        ...['value', 'error value', 'one cell', 'row range', 'column range', 'block', 'whole column', 'whole row'],
        ...['constant', 'array of one', 'references', 'union'],
        ...['value with array', 'equal shapes', 'repeating shapes', 'mismatched shapes'],
        ...['+', '-', '*', '/', '^', '&', '=', '<>', '<', '<=', '>', '>=', 'unary -', 'unary +', 'unary %'],
        'cells on a loop',
    ]) {
        if ((covered.get(mark) ?? 0) <= (COUNT >= 8000 ? 100 : 0)) throw new Error(`${mark} came up too seldom`);
    }
    expect(elements).toBeGreaterThan(COUNT);
}, 300_000);
