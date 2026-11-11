import { describe, expect, test } from 'bun:test';
import type { Engine, FormulaError } from '../../index';
import { DIV0, NA } from '../../index';
import { at, engineOf, stored, valueAt } from '../recalc/support';

type Cell = number | string | boolean | FormulaError | undefined;

// A value a cell can hold, and how a formula spells it.
type Entry = { readonly value: Cell; readonly typed: string };

const POOL: readonly Entry[] = [
    { value: 0, typed: '0' },
    { value: 1, typed: '1' },
    { value: 2, typed: '2' },
    { value: 5, typed: '5' },
    { value: -1, typed: '(0-1)' },
    { value: 0.3, typed: '0.3' },
    { value: 0.1 + 0.2, typed: '(0.1+0.2)' },
    { value: 1234567890123456, typed: '(1234567890123450+6)' },
    { value: 1234567890123457, typed: '(1234567890123450+7)' },
    { value: 1234567890123490, typed: '1234567890123490' },
    { value: 'ab', typed: '"ab"' },
    { value: 'AB', typed: '"AB"' },
    { value: 'aB', typed: '"aB"' },
    { value: 'cd', typed: '"cd"' },
    { value: '5', typed: '"5"' },
    { value: '5.0', typed: '"5.0"' },
    { value: ' 2 ', typed: '" 2 "' },
    { value: '1234567890123456', typed: '"1234567890123456"' },
    { value: '1234567890123457', typed: '"1234567890123457"' },
    { value: '', typed: '""' },
    { value: true, typed: 'TRUE' },
    { value: false, typed: 'FALSE' },
    { value: NA, typed: '#N/A' },
    { value: DIV0, typed: '#DIV/0!' },
    { value: undefined, typed: '' },
];

// The number each text of the pool reads as when a criterion looks at it.
const READS = new Map([
    ['5', 5],
    ['5.0', 5],
    [' 2 ', 2],
    ['1234567890123456', 1234567890123450],
    ['1234567890123457', 1234567890123450],
]);

type KeyKind = 'number' | 'text' | 'boolean';

const ORDERS: readonly (readonly KeyKind[])[] = [
    ['number', 'text', 'boolean'],
    ['number', 'boolean', 'text'],
    ['text', 'number', 'boolean'],
    ['text', 'boolean', 'number'],
    ['boolean', 'number', 'text'],
    ['boolean', 'text', 'number'],
];

const ROWS = 90;
// Ranges may run this far past the last row that holds something.
const PAST = 6;

function random(seed: number): (below: number) => number {
    let state = seed;
    return (below) => {
        state = (state + 0x6d2b79f5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return Math.floor((((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296) * below);
    };
}

function same15(a: number, b: number): boolean {
    return Number(a.toPrecision(15)) === Number(b.toPrecision(15));
}

// A lookup's rule, read off the cells one by one: only a cell of the key's kind can equal it.
function found(cell: Cell, key: number | string | boolean): boolean {
    if (typeof key === 'number') return typeof cell === 'number' && same15(cell, key);
    if (typeof key === 'string') return typeof cell === 'string' && cell.toUpperCase() === key.toUpperCase();
    return cell === key;
}

// An equality criterion's rule: a number also takes the text that reads as it, and the empty text a blank.
function counted(cell: Cell, key: Cell): boolean {
    const number = key === undefined ? 0 : typeof key === 'string' ? READS.get(key) : key;
    if (typeof number === 'number') {
        const read = typeof cell === 'string' ? READS.get(cell) : cell;
        return typeof read === 'number' && same15(read, number);
    }
    if (key === '') return cell === undefined || cell === '';
    if (typeof key === 'string') return typeof cell === 'string' && cell.toUpperCase() === key.toUpperCase();
    return cell === key;
}

type Check = { readonly label: string; readonly formula: string; readonly expected: () => unknown };

// D holds the keys, E a weight per row, F a second column to filter on. K1 and K2 are what the formulas in A
// search for.
class Model {
    public readonly keys: Cell[] = [];
    public readonly seconds: number[] = [];
    public key: Cell = undefined;
    public second = 0;
    public readonly checks: Check[] = [];

    public weight(row: number): number {
        return row < ROWS ? row + 1 : 0;
    }

    // The formulas of one range of rows, each with the answer a walk over the cells gives.
    public add(top: number, bottom: number): void {
        const rows = Array.from({ length: bottom - top + 1 }, (_, i) => top + i);
        const d = `D${top + 1}:D${bottom + 1}`;
        const e = `E${top + 1}:E${bottom + 1}`;
        const f = `F${top + 1}:F${bottom + 1}`;
        const first = (blank: boolean, from: readonly number[]) => {
            const { key } = this;
            if (typeof key === 'object') return key;
            const sought = key ?? (blank ? undefined : 0);
            return from.find((row) =>
                sought === undefined ? this.keys[row] === undefined : found(this.keys[row], sought),
            );
        };
        const position = (row: unknown) => (typeof row === 'number' ? row - top + 1 : (row ?? NA));
        const weight = (row: unknown, missing: unknown) =>
            typeof row === 'number' ? this.weight(row) : (row ?? missing);
        const matched = () => rows.filter((row) => counted(this.keys[row], this.key));
        const both = () => matched().filter((row) => row < ROWS && this.seconds[row] === this.second);
        const sum = (of: readonly number[]) => of.reduce((total, row) => total + this.weight(row), 0);
        const formulas: [string, () => unknown][] = [
            [`=MATCH(K1,${d},0)`, () => position(first(false, rows))],
            [`=XMATCH(K1,${d})`, () => position(first(true, rows))],
            [`=XMATCH(K1,${d},0,-1)`, () => position(first(true, [...rows].reverse()))],
            [`=XLOOKUP(K1,${d},${e},"none")`, () => weight(first(true, rows), 'none')],
            [`=XLOOKUP(K1,${d},${e},"none",0,-1)`, () => weight(first(true, [...rows].reverse()), 'none')],
            [`=VLOOKUP(K1,D${top + 1}:E${bottom + 1},2,FALSE)`, () => weight(first(false, rows), NA)],
            [`=COUNTIF(${d},K1)`, () => matched().length],
            [`=SUMIF(${d},K1,${e})`, () => sum(matched())],
            [`=COUNTIFS(${d},K1,${f},K2)`, () => both().length],
            [`=SUMIFS(${e},${d},K1,${f},K2)`, () => sum(both())],
            [`=MAXIFS(${e},${f},K2,${d},K1)`, () => Math.max(0, ...both().map((row) => this.weight(row)))],
        ];
        for (const [formula, expected] of formulas) {
            this.checks.push({ label: `A${this.checks.length + 1}`, formula, expected });
        }
    }

    public verify(engine: Engine): void {
        for (const { label, formula, expected } of this.checks) {
            const got = valueAt(engine, label);
            const want = expected();
            if (got !== want)
                throw new Error(`${formula} with K1 = ${String(this.key)}: ${String(got)}, not ${String(want)}`);
        }
        expect(this.checks.length).toBeGreaterThan(0);
    }
}

function setKey(engine: Engine, model: Model, pick: (below: number) => number): void {
    model.key = POOL[pick(POOL.length)].value;
    model.second = pick(3);
    if (model.key === undefined) engine.clear('s1', 0, 10);
    else engine.setValue('s1', 0, 10, model.key);
    engine.setValue('s1', 1, 10, model.second);
}

function addRange(engine: Engine, model: Model, pick: (below: number) => number): void {
    const top = pick(ROWS);
    const from = model.checks.length;
    model.add(top, Math.min(ROWS + PAST - 1, top + pick(pick(2) === 0 ? 12 : ROWS)));
    for (const { label, formula } of model.checks.slice(from)) {
        engine.setFormula('s1', ...at(label), stored(formula, label));
    }
}

describe('the column index against a walk over the cells', () => {
    test.each([1, 2, 3, 4, 5, 6])('typed keys, with writes in between: seed %i', (seed) => {
        const pick = random(seed);
        const model = new Model();
        const engine = engineOf({ s1: {} });
        for (let row = 0; row < ROWS; row += 1) {
            model.keys[row] = POOL[pick(POOL.length)].value;
            model.seconds[row] = pick(3);
            const key = model.keys[row];
            if (key !== undefined) engine.setValue('s1', row, 3, key);
            engine.setValue('s1', row, 4, model.weight(row));
            engine.setValue('s1', row, 5, model.seconds[row]);
        }
        for (let round = 0; round < 40; round += 1) {
            setKey(engine, model, pick);
            addRange(engine, model, pick);
            for (let writes = pick(4) === 0 ? pick(5) : 0; writes > 0; writes -= 1) {
                const row = pick(ROWS);
                model.keys[row] = POOL[pick(POOL.length)].value;
                const key = model.keys[row];
                if (key === undefined) engine.clear('s1', row, 3);
                else engine.setValue('s1', row, 3, key);
            }
            // Twice with nothing written in between, so the second pass reads what the first one built.
            engine.recalc(Number.POSITIVE_INFINITY);
            model.verify(engine);
            engine.recalc(Number.POSITIVE_INFINITY);
            model.verify(engine);
        }
    });

    test.each([11, 12, 13])('keys that are formulas on a cell that changes: seed %i', (seed) => {
        const pick = random(seed);
        const model = new Model();
        const typed = POOL.filter((entry) => entry.value !== undefined);
        const choices: [Entry, Entry][] = [];
        const engine = engineOf({ s1: { Z1: 1 } });
        for (let row = 0; row < ROWS; row += 1) {
            choices[row] = [typed[pick(typed.length)], typed[pick(typed.length)]];
            model.keys[row] = choices[row][0].value;
            model.seconds[row] = pick(3);
            const label = `D${row + 1}`;
            const formula = `=IF($Z$1=1,${choices[row][0].typed},${choices[row][1].typed})`;
            engine.setFormula('s1', row, 3, stored(formula, label));
            engine.setValue('s1', row, 4, model.weight(row));
            engine.setValue('s1', row, 5, model.seconds[row]);
        }
        for (let round = 0; round < 30; round += 1) {
            setKey(engine, model, pick);
            addRange(engine, model, pick);
            const side = pick(2);
            engine.setValue('s1', 0, 25, side + 1);
            for (let row = 0; row < ROWS; row += 1) model.keys[row] = choices[row][side].value;
            engine.recalc(Number.POSITIVE_INFINITY);
            model.verify(engine);
        }
    });

    // Every order of the three kinds of key, each asked three times so that the second and third read the index.
    for (const order of ORDERS) {
        test(`each kind of key finds its own cells whichever was asked first: ${order.join(', ')}`, () => {
            const cells = { A1: '5', A2: 'x', A3: 5, A4: true, A5: '5.0', A6: 'X', A7: 5, A8: false, A9: true };
            const engine = engineOf({
                s1: { ...cells, B1: 1, B2: 2, B3: 4, B4: 8, B5: 16, B6: 32, B7: 64, B8: 128, B9: 256 },
            });
            let next = 1;
            const ask = (formula: string) => {
                const label = `D${next}`;
                next += 1;
                engine.setFormula('s1', ...at(label), stored(formula, label));
                engine.recalc(Number.POSITIVE_INFINITY);
                return valueAt(engine, label);
            };
            const asks = {
                number: () => [ask('=COUNTIF(A1:A9,5)'), ask('=SUMIF(A1:A9,5,B1:B9)'), ask('=MATCH(5,A1:A9,0)')],
                text: () => [ask('=COUNTIF(A1:A9,"x")'), ask('=SUMIF(A1:A9,"X",B1:B9)'), ask('=MATCH("5",A1:A9,0)')],
                boolean: () => [
                    ask('=COUNTIF(A1:A9,TRUE)'),
                    ask('=SUMIF(A1:A9,TRUE,B1:B9)'),
                    ask('=MATCH(FALSE,A1:A9,0)'),
                ],
            };
            const answers = { number: [4, 85, 3], text: [2, 34, 1], boolean: [2, 264, 8] };
            for (let round = 0; round < 3; round += 1) {
                for (const kind of order)
                    expect([kind, round, ...asks[kind]()]).toEqual([kind, round, ...answers[kind]]);
            }
            // A write drops the whole index: the text that read as 5 is gone, and so is the first x.
            engine.setValue('s1', 0, 0, 'x');
            engine.setValue('s1', 1, 0, 6);
            const after = { number: [3, 84, 3], text: [2, 33, 1], boolean: [2, 264, 8] };
            for (let round = 0; round < 3; round += 1) {
                for (const kind of order) {
                    const got =
                        kind === 'text'
                            ? [ask('=COUNTIF(A1:A9,"x")'), ask('=SUMIF(A1:A9,"X",B1:B9)'), ask('=MATCH("X",A1:A9,0)')]
                            : asks[kind]();
                    expect([kind, round, ...got]).toEqual([kind, round, ...after[kind]]);
                }
            }
        });
    }

    test('a write between two reads of a column is seen by the second', () => {
        const engine = engineOf({ s1: { A1: 'x', A2: 'y', A3: 'x', B1: 1, B2: 2, B3: 3 } });
        const ask = (label: string, formula: string) => {
            engine.setFormula('s1', ...at(label), stored(formula, label));
            engine.recalc(Number.POSITIVE_INFINITY);
            return valueAt(engine, label);
        };
        expect(ask('D1', '=MATCH("y",A1:A3,0)')).toBe(2);
        expect(ask('D2', '=MATCH("y",A1:A3,0)')).toBe(2);
        expect(ask('D3', '=COUNTIF(A1:A3,"x")')).toBe(2);
        engine.setValue('s1', 1, 0, 'x');
        expect(ask('D4', '=MATCH("y",A1:A3,0)')).toBe(NA);
        expect(ask('D5', '=COUNTIF(A1:A3,"x")')).toBe(3);
        expect(ask('D6', '=SUMIF(A1:A3,"x",B1:B3)')).toBe(6);
        engine.setValue('s1', 1, 0, 'x');
        expect(ask('D7', '=XMATCH("x",A1:A3,0,-1)')).toBe(3);
        engine.clear('s1', 2, 0);
        expect(ask('D8', '=XMATCH("x",A1:A3,0,-1)')).toBe(2);
        expect(ask('D9', '=COUNTIF(A:A,"x")')).toBe(2);
    });
});
