import { describe, expect, test } from 'bun:test';
import type { Literal, SheetSource } from '../../index';
import { Engine } from '../../index';
import { parseStored } from '../../text';
import { random } from '../store/support';

// The law of incremental recalc: after any sequence of writes with recalcs in between, stopped ones included, every
// cell holds what a fresh engine computes from the same inputs, and the same cells are on a loop.

const NO_CAP = Number.POSITIVE_INFINITY;
const SHEETS = ['s1', 's2'];
const ROWS = 12;
const COLUMNS = 6;

type Input = { readonly value: Literal | null; readonly formula: string | null };
type Model = Map<string, Map<number, Input>>;

function sources(model: Model, cached: Engine | null): SheetSource[] {
    return SHEETS.map((id) => ({
        id,
        name: id,
        cells: (cell) => {
            for (const [key, { value, formula }] of model.get(id) ?? []) {
                const row = Math.floor(key / 100);
                const column = key % 100;
                if (formula === null) cell(row, column, value, null);
                else cell(row, column, cached === null ? null : cached.valueOf(id, row, column), formula);
            }
        },
    }));
}

function values(engine: Engine): unknown[] {
    const all: unknown[] = [];
    for (const id of SHEETS) {
        for (let row = 0; row < ROWS + 3; row += 1) {
            for (let column = 0; column < COLUMNS + 3; column += 1) {
                const value = engine.valueOf(id, row, column);
                all.push(typeof value === 'object' && value !== null ? value.text : value);
            }
        }
    }
    return all;
}

// Random stored formulas over a small block of two sheets: every mix of absolute and relative ends, ranges whose
// corners cross, whole columns and rows, also as arrays, other sheets, sheets that do not exist, and the range
// operator.
function generator(next: () => number) {
    const pick = (n: number) => Math.floor(next() * n);
    const end = (letter: string, size: number) => {
        if (pick(2) === 0) return `${letter}${1 + pick(size)}`;
        const offset = pick(9) - 4;
        return offset === 0 ? letter : `${letter}[${offset}]`;
    };
    const sheet = () => (pick(4) === 0 ? `[${SHEETS[pick(2)]}]!` : '');
    const cell = () => `${sheet()}${end('R', ROWS)}${end('C', COLUMNS)}`;
    const range = () => `${cell()}:${end('R', ROWS)}${end('C', COLUMNS)}`;
    const columns = () => `${sheet()}${end('C', COLUMNS)}:${end('C', COLUMNS)}`;
    const rows = () => `${sheet()}${end('R', ROWS)}:${end('R', ROWS)}`;
    const formula = (): string => {
        switch (pick(21)) {
            case 0:
                return `=${cell()}+${cell()}`;
            case 1:
                return `=${cell()}*2-${cell()}`;
            case 2:
                return `=SUM(${range()})`;
            case 3:
                return `=SUM(${range()},${cell()})`;
            case 4:
                return `=SUM(${columns()})`;
            case 5:
                return `=SUM(${rows()})`;
            case 6:
                return `=IF(${cell()}>${pick(9)},${cell()},${cell()}*2)`;
            case 7:
                return `=IFERROR(${cell()}/${cell()},${cell()})`;
            case 8:
                return `=SUM(${cell()}:INDEX(${range()},1,1))`;
            case 9:
                return `=${cell()}&"x"`;
            case 10:
                return `=INDEX(${range()},${1 + pick(3)},1)`;
            case 11:
                return `=SUMPRODUCT(${range()},${range()})`;
            case 12:
                return `='Nope'!R1C1+${cell()}`;
            case 13:
                return `=SUMIF(${range()},">2",${cell()})`;
            case 14:
                return `=SUMPRODUCT(--(${columns()}=${pick(3)}))`;
            case 15:
                return `=SUM(${columns()}*${rows()})`;
            case 16:
                return `=INDEX(${rows()}&"",1,${1 + pick(9)})`;
            case 17:
                return `=COUNT(${columns()}+${cell()})`;
            case 18:
                return `=MAX(IF(${columns()}="",${pick(5)},${columns()}))`;
            case 19:
                return `=MATCH(${pick(9)},${columns()}*1,0)`;
            default:
                return `=SUM(${range()} ${range()})+${pick(5)}`;
        }
    };
    const literal = (): Literal => [pick(10), pick(10), pick(100) / 4, 'a', '7', true][pick(6)];
    return { pick, formula, literal };
}

function run(seed: number, steps: number): { compared: number; stops: number } {
    const { pick, formula, literal } = generator(random(seed));
    const model: Model = new Map(SHEETS.map((id) => [id, new Map()]));
    let engine = new Engine(sources(model, null));
    const write = (id: string, row: number, column: number, input: Input | null) => {
        const cells = model.get(id);
        if (input === null) {
            cells?.delete(row * 100 + column);
            engine.clear(id, row, column);
        } else {
            cells?.set(row * 100 + column, input);
            if (input.formula !== null) engine.setFormula(id, row, column, input.formula);
            else if (input.value !== null) engine.setValue(id, row, column, input.value);
        }
    };
    let compared = 0;
    let stops = 0;
    // An engine opened from cached values knows a loop only once a recalc has computed it again.
    let knowsLoops = true;
    for (let step = 0; step < steps; step += 1) {
        const id = SHEETS[pick(2)];
        const row = pick(ROWS);
        const column = pick(COLUMNS);
        const kind = pick(20);
        if (kind < 7) write(id, row, column, { value: literal(), formula: null });
        else if (kind < 12) write(id, row, column, { value: null, formula: formula() });
        else if (kind < 15) write(id, row, column, null);
        else {
            // A block of one input: a formula filled down, right or both, a pasted value, or a cleared area.
            const input =
                kind < 18
                    ? { value: null, formula: formula() }
                    : kind < 19
                      ? { value: literal(), formula: null }
                      : null;
            const bottom = Math.min(ROWS - 1, row + pick(6));
            const right = Math.min(COLUMNS - 1, column + pick(3));
            for (let r = row; r <= bottom; r += 1) {
                for (let c = column; c <= right; c += 1) write(id, r, c, input);
            }
        }
        if (pick(5) < 3) continue;
        let result = engine.recalc(pick(4) === 0 ? pick(12) : NO_CAP);
        if (result.stopped) {
            stops += 1;
            // More writes land before the stopped pass goes on, or it goes on in small steps.
            if (pick(2) === 0) continue;
            const cap = 1 + pick(6);
            while (result.stopped) result = engine.recalc(cap);
        }
        const fresh = new Engine(sources(model, null));
        const expected = fresh.recalc(NO_CAP);
        expect([seed, step, ...values(engine)]).toEqual([seed, step, ...values(fresh)]);
        if (knowsLoops) expect([seed, step, result.loops]).toEqual([seed, step, expected.loops]);
        compared += 1;
        // Now and then the workbook is opened again from its cached values, as a tab that joins.
        if (pick(12) === 0) {
            engine = new Engine(sources(model, engine));
            knowsLoops = expected.loops.length === 0;
        }
    }
    return { compared, stops };
}

describe('held against a fresh load', () => {
    test('the generator writes formulas that parse', () => {
        const { formula } = generator(random(1));
        for (let i = 0; i < 500; i += 1) expect(parseStored(formula())).not.toHaveProperty('reason');
    });

    test.each([[1], [2], [3], [4], [5], [6], [7], [8], [9], [10], [11], [12]])(
        'after random writes and recalcs every cell equals a fresh full recalc: seed %i',
        (seed) => {
            const { compared, stops } = run(seed, 1500);
            expect(compared).toBeGreaterThan(300);
            expect(stops).toBeGreaterThan(10);
        },
    );
});
