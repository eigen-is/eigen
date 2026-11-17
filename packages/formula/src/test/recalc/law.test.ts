import { describe, expect, test } from 'bun:test';
import type { Literal, SheetSource } from '../../index';
import { Engine, REF } from '../../index';
import { parseStored } from '../../text';
import { random } from '../store/support';

// The law of incremental recalc: after any sequence of writes, line edits, moves, clocks and changes of the rows a
// sheet hides or filters, with recalcs in between, stopped ones included, every cell holds what a fresh engine
// computes from the same inputs and the same rows, and the same cells are on a loop. And the reload law: a walk of
// an engine that is settled, loaded as computed with those rows, computes nothing and holds those values, now and
// after later writes; a walk of one that is not, loaded as not computed, computes them.

const NO_CAP = Number.POSITIVE_INFINITY;
const SHEETS = ['s1', 's2'];
const ROWS = 12;
const COLUMNS = 6;
// A formula this build cannot evaluate: it keeps the value it is written with.
const KEPT = "='[1]Book'!R1C1+";

// The value of a formula is the one it is written with, which only a formula this build cannot evaluate keeps.
type Input = { readonly value: Literal | null; readonly formula: string | null };
type Model = Map<string, Map<number, Input>>;
// The rows each sheet hides and filters, which the host holds and says: the engine hands none back.
type RowsOut = { readonly hidden: readonly number[]; readonly filtered: readonly number[] };
type Rows = Map<string, RowsOut>;

function sources(model: Model, rows: Rows): SheetSource[] {
    return SHEETS.map((id) => ({
        id,
        name: id,
        cells: (cell) => {
            for (const [key, { value, formula }] of model.get(id) ?? [])
                cell(Math.floor(key / 100), key % 100, value, formula);
        },
        ...rows.get(id),
    }));
}

// The engine's own walk, the snapshot a host writes, with the rows the host holds beside it.
function walked(engine: Engine, rows: Rows): SheetSource[] {
    return SHEETS.map((id) => ({ id, name: id, cells: (cell) => engine.cells(id, cell), ...rows.get(id) }));
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
        switch (pick(28)) {
            case 24:
                return `=SUBTOTAL(${[9, 109, 3, 103, 1, 104][pick(6)]},${range()})`;
            case 25:
                return `=SUBTOTAL(${pick(2) === 0 ? 9 : 109},${columns()},${range()})`;
            case 26:
                return `=AGGREGATE(${[9, 4, 2][pick(3)]},${pick(8)},${range()})`;
            case 27:
                return `=SUBTOTAL(109,OFFSET(${cell()},0,0,${1 + pick(5)},${1 + pick(2)}))`;
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
    // Rows left out, as sorted pairs that share no row and may touch, past the last cell too.
    const pairs = (): number[] => {
        const list: number[] = [];
        for (let row = pick(4); row < ROWS + 3 && pick(4) > 0; row += pick(4)) {
            const last = row + pick(3);
            list.push(row, last);
            row = last + 1;
        }
        return list;
    };
    return { pick, formula, literal, pairs };
}

type Counts = {
    compared: number;
    stops: number;
    // Reloads of a settled walk, those of them that held a #REF! formula and got no pass of their own, and the
    // formulas with no value they held; reloads after a stopped pass and after writes or a clock no pass followed.
    computed: number;
    waiting: number;
    blanks: number;
    stopped: number;
    written: number;
    edits: number;
    // Changes of the rows a sheet leaves out, the same rows said again, the reloads right after a change with no
    // pass between, the edits that moved cells of a sheet that leaves rows out, and the computed loads with such rows.
    rows: number;
    sameRows: number;
    rowsUnpassed: number;
    rowEdits: number;
    rowLoads: number;
};

function run(seed: number, steps: number): Counts {
    const { pick, formula, literal, pairs } = generator(random(seed));
    const model: Model = new Map(SHEETS.map((id) => [id, new Map()]));
    const rows: Rows = new Map(SHEETS.map((id) => [id, { hidden: [], filtered: [] }]));
    const leavesOut = (id: string) => (rows.get(id)?.hidden.length ?? 0) + (rows.get(id)?.filtered.length ?? 0) > 0;
    let now = 0;
    let clock = 0;
    let engine = new Engine(sources(model, rows), now, clock, false);
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
    const counts: Counts = {
        compared: 0,
        stops: 0,
        computed: 0,
        waiting: 0,
        blanks: 0,
        stopped: 0,
        written: 0,
        edits: 0,
        rows: 0,
        sameRows: 0,
        rowsUnpassed: 0,
        rowEdits: 0,
        rowLoads: 0,
    };
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
        const engine = new Engine(sources(model, rows), now, clock, false);
        return { engine, result: engine.recalc(NO_CAP) };
    };
    // The workbook opened again from a walk of the engine, as a tab that joins: as computed exactly when it is settled.
    const reopen = (counted: 'stopped' | 'written' | null) => {
        const old = engine;
        const settled = old.settled();
        engine = new Engine(walked(old, rows), now, clock, settled);
        if (!settled) {
            if (counted !== null) counts[counted] += 1;
            return;
        }
        counts.computed += 1;
        if (SHEETS.some(leavesOut)) counts.rowLoads += 1;
        // A formula that holds #REF! is computed again, as it may be on a loop, and what reads it.
        let refs = 0;
        for (const id of SHEETS) {
            old.cells(id, (_row, _column, value, text) => {
                if (text !== null && value === null) counts.blanks += 1;
                if (text !== null && value === REF) refs += 1;
            });
        }
        expect([seed, engine.settled(), ...values(engine)]).toEqual([seed, refs === 0, ...values(old)]);
        // Half of the loads meet the next writes and edits before their first pass, its #REF! formulas still seeds.
        if (pick(2) === 0) {
            if (refs > 0) counts.waiting += 1;
            return;
        }
        const expected = fresh();
        expect([seed, engine.recalc(NO_CAP)]).toEqual([
            seed,
            { loops: expected.result.loops, stopped: false, changed: [] },
        ]);
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
        const kind = pick(25);
        if (kind >= 22) {
            // The host hides, shows or filters rows: one list or both, or says the rows it said before.
            const held = rows.get(id) ?? { hidden: [], filtered: [] };
            const next =
                kind === 22
                    ? held
                    : { hidden: pick(3) > 0 ? pairs() : held.hidden, filtered: pick(3) > 0 ? pairs() : held.filtered };
            const same = JSON.stringify(next) === JSON.stringify(held);
            const settled = engine.settled();
            engine.setRowsOut(id, next.hidden, next.filtered);
            expect([seed, step, engine.settled()]).toEqual([seed, step, same && settled]);
            rows.set(id, next);
            counts[same ? 'sameRows' : 'rows'] += 1;
            if (!same && pick(4) === 0) {
                counts.rowsUnpassed += 1;
                reopen('written');
                continue;
            }
        } else if (kind < 7) write(id, row, column, { value: literal(), formula: null });
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
            // The rows a sheet leaves out stay the rows they were, whatever cells the edit moves onto them.
            if (kind === 20) {
                const byRows = pick(3) > 0;
                const index = pick(byRows ? ROWS : COLUMNS);
                engine.editLines({ insert: pick(2) === 0, index, count: 1 + pick(2), sheet: id, rows: byRows });
                if (byRows && leavesOut(id)) counts.rowEdits += 1;
            } else {
                const toSheet = SHEETS[pick(2)];
                engine.moveCells({
                    fromSheet: id,
                    row,
                    column,
                    rows: 1 + pick(3),
                    columns: 1 + pick(2),
                    toSheet,
                    toRow: pick(ROWS),
                    toColumn: pick(COLUMNS),
                });
                if (leavesOut(id) || leavesOut(toSheet)) counts.rowEdits += 1;
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

    // A workbook can go a whole run with few formulas that hold no value, so their floor is of the seeds together.
    const blanks: number[] = [];
    test.each(Array.from({ length: Number(process.env['LAW_SEEDS'] ?? 12) }, (_, seed) => [seed + 1]))(
        'after random writes, line edits, moves, clocks, rows left out, recalcs and reloads every cell equals a fresh full recalc: seed %i',
        (seed) => {
            const counts = run(seed, 1500);
            if (process.env['LAW_SEEDS'] !== undefined) console.log(JSON.stringify({ seed, ...counts }));
            expect(counts.compared).toBeGreaterThan(300);
            expect(counts.stops).toBeGreaterThan(10);
            expect(counts.computed).toBeGreaterThan(50);
            expect(counts.waiting).toBeGreaterThan(20);
            expect(counts.stopped).toBeGreaterThan(2);
            expect(counts.written).toBeGreaterThan(10);
            expect(counts.edits).toBeGreaterThan(50);
            expect(counts.rows).toBeGreaterThan(60);
            expect(counts.sameRows).toBeGreaterThan(20);
            expect(counts.rowsUnpassed).toBeGreaterThan(10);
            expect(counts.rowEdits).toBeGreaterThan(30);
            expect(counts.rowLoads).toBeGreaterThan(30);
            blanks.push(counts.blanks);
        },
    );

    test('the computed loads of the seeds together held formulas with no value, over 100 a seed', () => {
        expect(blanks.reduce((sum, held) => sum + held, 0)).toBeGreaterThanOrEqual(100 * blanks.length);
    });
});
