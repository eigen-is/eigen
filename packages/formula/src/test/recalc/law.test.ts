import { describe, expect, test } from 'bun:test';
import type { Literal, SheetSource } from '../../index';
import { Engine, REF } from '../../index';
import { parseStored } from '../../text';
import { random } from '../store/support';

// The law of incremental recalc: after any sequence of writes, line edits, moves and clocks with recalcs in between, stopped ones
// included, every cell holds what a fresh engine computes from the same inputs, and the same cells are on a loop.
// And the reload law: a walk of an engine that is settled, loaded as computed, computes nothing and holds those
// values, now and after later writes; a walk of one that is not, loaded as not computed, computes them.

const NO_CAP = Number.POSITIVE_INFINITY;
const SHEETS = ['s1', 's2'];
const ROWS = 12;
const COLUMNS = 6;
// A formula this build cannot evaluate: it keeps the value it is written with.
const KEPT = "='[1]Book'!R1C1+";

// The value of a formula is the one it is written with, which only a formula this build cannot evaluate keeps.
type Input = { readonly value: Literal | null; readonly formula: string | null };
type Model = Map<string, Map<number, Input>>;

function sources(model: Model): SheetSource[] {
    return SHEETS.map((id) => ({
        id,
        name: id,
        cells: (cell) => {
            for (const [key, { value, formula }] of model.get(id) ?? [])
                cell(Math.floor(key / 100), key % 100, value, formula);
        },
    }));
}

// The engine's own walk, the snapshot a host writes.
function walked(engine: Engine): SheetSource[] {
    return SHEETS.map((id) => ({ id, name: id, cells: (cell) => engine.cells(id, cell) }));
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
        switch (pick(24)) {
            case 21:
                return `=NOW()+${cell()}`;
            case 22:
                return `=RAND()+${cell()}`;
            case 23:
                return `=${cell()}`;
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

type Counts = {
    compared: number;
    stops: number;
    // Reloads of a settled walk, and the formulas with no value they held; reloads after a stopped pass and after
    // writes or a clock no pass followed.
    computed: number;
    blanks: number;
    stopped: number;
    written: number;
    edits: number;
};

function run(seed: number, steps: number): Counts {
    const { pick, formula, literal } = generator(random(seed));
    const model: Model = new Map(SHEETS.map((id) => [id, new Map()]));
    let now = 0;
    let clock = 0;
    let engine = new Engine(sources(model), now, clock, false);
    const write = (id: string, row: number, column: number, input: Input | null) => {
        const cells = model.get(id);
        if (input === null) {
            cells?.delete(row * 100 + column);
            engine.clear(id, row, column);
        } else {
            cells?.set(row * 100 + column, input);
            if (input.formula !== null) engine.setFormula(id, row, column, input.formula, input.value);
            else if (input.value !== null) engine.setValue(id, row, column, input.value);
        }
    };
    const counts: Counts = { compared: 0, stops: 0, computed: 0, blanks: 0, stopped: 0, written: 0, edits: 0 };
    // After a line edit or a move the inputs are the engine's walk, as the edit law holds its rewrites.
    const remodel = () => {
        for (const id of SHEETS) {
            const cells = new Map<number, Input>();
            engine.cells(id, (row, column, value, formula) => {
                const kept = formula?.startsWith(KEPT) === true;
                if (formula !== null || value !== null)
                    cells.set(row * 100 + column, { value: formula === null || kept ? value : null, formula });
            });
            model.set(id, cells);
        }
    };
    const fresh = () => {
        const engine = new Engine(sources(model), now, clock, false);
        return { engine, result: engine.recalc(NO_CAP) };
    };
    // The workbook opened again from a walk of the engine, as a tab that joins: as computed exactly when it is settled.
    const reopen = (counted: 'stopped' | 'written' | null) => {
        const old = engine;
        const settled = old.settled();
        engine = new Engine(walked(old), now, clock, settled);
        if (!settled) {
            if (counted !== null) counts[counted] += 1;
            return;
        }
        counts.computed += 1;
        // A formula that holds #REF! is computed again, as it may be on a loop.
        let refs = 0;
        for (const id of SHEETS) {
            old.cells(id, (_row, _column, value, text) => {
                if (text !== null && value === null) counts.blanks += 1;
                if (text !== null && value === REF) refs += 1;
            });
        }
        const expected = fresh();
        expect([seed, engine.settled(), engine.recalc(NO_CAP)]).toEqual([
            seed,
            refs === 0,
            { loops: expected.result.loops, stopped: false, changed: [] },
        ]);
        expect([seed, ...values(engine)]).toEqual([seed, ...values(old)]);
        expect([seed, ...values(engine)]).toEqual([seed, ...values(expected.engine)]);
    };
    for (let step = 0; step < steps; step += 1) {
        if (pick(15) === 0) {
            // A batch that writes nothing still sets its clock.
            now = pick(1000);
            clock = pick(1000);
            engine.setClock(now, clock);
            reopen('written');
            continue;
        }
        const id = SHEETS[pick(2)];
        const row = pick(ROWS);
        const column = pick(COLUMNS);
        const kind = pick(22);
        if (kind < 7) write(id, row, column, { value: literal(), formula: null });
        else if (kind < 11) write(id, row, column, { value: null, formula: formula() });
        else if (kind < 12) write(id, row, column, { value: literal(), formula: `${KEPT}${pick(9)}` });
        else if (kind < 15) write(id, row, column, null);
        else if (kind < 20) {
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
        } else {
            // A structural edit, which most often no clock follows: what it moves still computes as it would there.
            if (kind === 20) {
                const rows = pick(3) > 0;
                const index = pick(rows ? ROWS : COLUMNS);
                engine.editLines({ insert: pick(2) === 0, index, count: 1 + pick(2), sheet: id, rows });
            } else {
                engine.moveCells({
                    fromSheet: id,
                    row,
                    column,
                    rows: 1 + pick(3),
                    columns: 1 + pick(2),
                    toSheet: SHEETS[pick(2)],
                    toRow: pick(ROWS),
                    toColumn: pick(COLUMNS),
                });
            }
            counts.edits += 1;
            remodel();
        }
        if (pick(4) === 0) {
            now = pick(1000);
            clock = pick(1000);
            engine.setClock(now, clock);
        }
        if (pick(5) < 3) {
            if (pick(6) === 0) reopen('written');
            continue;
        }
        let result = engine.recalc(pick(4) === 0 ? pick(12) : NO_CAP);
        if (result.stopped) {
            counts.stops += 1;
            // More writes land before the stopped pass goes on, or it goes on in small steps.
            if (pick(2) === 0) {
                if (pick(3) === 0) reopen('stopped');
                continue;
            }
            const cap = 1 + pick(6);
            while (result.stopped) result = engine.recalc(cap);
        }
        const expected = fresh();
        expect([seed, step, engine.settled(), ...values(engine)]).toEqual([
            seed,
            step,
            true,
            ...values(expected.engine),
        ]);
        expect([seed, step, result.loops]).toEqual([seed, step, expected.result.loops]);
        counts.compared += 1;
        if (pick(3) === 0) reopen(null);
    }
    return counts;
}

describe('held against a fresh load', () => {
    test('the generator writes formulas that parse', () => {
        const { formula } = generator(random(1));
        for (let i = 0; i < 500; i += 1) expect(parseStored(formula())).not.toHaveProperty('reason');
    });

    test.each(Array.from({ length: Number(process.env['LAW_SEEDS'] ?? 12) }, (_, seed) => [seed + 1]))(
        'after random writes, line edits, moves, clocks, recalcs and reloads every cell equals a fresh full recalc: seed %i',
        (seed) => {
            const counts = run(seed, 1500);
            if (process.env['LAW_SEEDS'] !== undefined) console.log(JSON.stringify({ seed, ...counts }));
            expect(counts.compared).toBeGreaterThan(300);
            expect(counts.stops).toBeGreaterThan(10);
            expect(counts.computed).toBeGreaterThan(50);
            expect(counts.blanks).toBeGreaterThan(100);
            expect(counts.stopped).toBeGreaterThan(2);
            expect(counts.written).toBeGreaterThan(10);
            expect(counts.edits).toBeGreaterThan(50);
        },
    );
});
