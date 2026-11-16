import { describe, expect, test } from 'bun:test';
import type { Literal, SheetSource } from '../../index';
import { EditRefusal, Engine } from '../../index';
import { parseStored, sheetFinder, storedText } from '../../text';

// The law of formulas that work a reference out as they run: a workbook of OFFSET, INDIRECT, colons between calls
// and SUMIF ranges sized by another, beside plain and clock formulas, under random writes, structural and sheet
// edits, clocks and capped passes, loaded again as computed when it is settled. Whenever its passes have run to the
// end, every cell holds what a fresh load of the same cells computes under the same clock. Half of the steps are
// followed by no pass. And the marking is exact for a formula whose one area the law can tell: a write to that
// area flags it, and a write elsewhere does not.

const NO_CAP = Number.POSITIVE_INFINITY;
const ROWS = 10;
const COLUMNS = 6;
const NAMES = ['Alpha', 'Beta', 'Gam ma', 'Delta', 'Eps'];
// `=OFFSET($A$1,2,0)` as it is stored: it names one cell and resolves the one so many rows below it.
const PROBE = /^=OFFSET\(R(\d+)C(\d+),(\d),0\)$/;

type Tab = { readonly id: string; readonly name: string };
type Cell = readonly [row: number, column: number, value: Literal | null, formula: string | null];
type Counts = Record<string, number>;

const letter = (column: number) => String.fromCharCode(65 + column);
const quoted = (name: string) => (/^[A-Za-z]+$/.test(name) ? name : `'${name}'`);

function random(seed: number): () => number {
    let a = seed | 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Typed formulas over a small block of every sheet, most of them with a reference worked out from values.
function generator(next: () => number) {
    const pick = (n: number) => Math.floor(next() * n);
    const of = <T>(list: readonly T[]): T => list[pick(list.length)];
    const fixed = () => `$${letter(pick(COLUMNS))}$${1 + pick(ROWS)}`;
    const cell = () =>
        `${pick(4) === 0 ? '$' : ''}${letter(pick(COLUMNS))}${pick(4) === 0 ? '$' : ''}${1 + pick(ROWS)}`;
    const ref = () => (pick(4) === 0 ? `${quoted(of(NAMES))}!${cell()}` : cell());
    const range = () => {
        const column = pick(COLUMNS - 1);
        const row = pick(ROWS - 2);
        const sheet = pick(5) === 0 ? `${quoted(of(NAMES))}!` : '';
        return `${sheet}${letter(column)}${1 + row}:${letter(column + pick(2))}${2 + row + pick(3)}`;
    };
    const count = (): string =>
        of([`${pick(3)}`, `${pick(3)}`, ref(), ref(), 'RANDBETWEEN(0,2)', `-${pick(2)}`, 'ROW()-1']);
    const spot = () => `${letter(pick(COLUMNS))}${1 + pick(ROWS)}`;
    const spelled = () =>
        of([
            spot(),
            `${letter(pick(3))}${1 + pick(4)}:${letter(3 + pick(3))}${5 + pick(4)}`,
            `${quoted(of(NAMES))}!${letter(pick(COLUMNS))}${1 + pick(ROWS)}`,
        ]);
    const text = (): string =>
        of([
            `"${spelled()}"`,
            ref(),
            ref(),
            `"${letter(pick(COLUMNS))}"&(${count()}+1)`,
            `${ref()}&"!${letter(pick(COLUMNS))}${1 + pick(ROWS)}"`,
            `"${quoted(of(NAMES))}!"&"${letter(pick(COLUMNS))}"&(${count()}+1)`,
        ]);
    const resolving = (): string =>
        of([
            () => `OFFSET(${ref()},${count()},${count()})`,
            () => `OFFSET(${ref()},${count()},${count()},${1 + pick(3)},${1 + pick(2)})`,
            () => `OFFSET(${range()},${count()},${count()})`,
            () => `INDIRECT(${text()})`,
            () => `INDIRECT(${text()})`,
            () => `INDIRECT("R"&(${count()}+1)&"C"&(${count()}+1),FALSE)`,
            () => `INDIRECT("R[${pick(3) - 1}]C[${pick(3) - 1}]",FALSE)`,
            () => `OFFSET(OFFSET(${ref()},${count()},0),${count()},${count()})`,
            () => `OFFSET(INDIRECT(${text()}),${count()},${count()})`,
            () => `INDEX(${range()},1,1):INDEX(${range()},${1 + pick(2)},${1 + pick(2)})`,
            () => `${cell()}:OFFSET(${cell()},${count()},${count()})`,
        ])();
    const formula = (): string =>
        `=${of([
            () => resolving(),
            () => resolving(),
            () => `SUM(${resolving()})`,
            () => `SUM(${resolving()})`,
            () => `COUNTA(${resolving()})+${ref()}`,
            () => `SUMIF(${range()},">0",${ref()})`,
            () => `SUMIF(${range()},">0",${resolving()})`,
            () => `IF(${ref()}>1,${resolving()},${resolving()})`,
            () => `IFERROR(${resolving()},7)`,
            () => `${ref()}+1`,
            () => `${ref()}+${ref()}`,
            () => `SUM(${range()})`,
            () => 'RANDBETWEEN(0,3)',
            () => 'NOW()',
            () => `ROW(${resolving()})`,
            () => `INDEX(${resolving()},1,1)`,
            () => `MATCH(${count()},${resolving()},0)`,
            () => `SUM(OFFSET(${ref()},{0,1},0))`,
            () => `ISFORMULA(${resolving()})`,
            () => `SHEETS()+SHEET()+${ref()}`,
            () => `IF(${ref()},${ref()},2)`,
            () => `${resolving()}+${resolving()}`,
            // Two sheets for sure, and no cell named: only the box of each sheet says what it reads.
            () => `INDIRECT("${quoted(NAMES[0])}!${spot()}")+INDIRECT("${quoted(NAMES[1 + pick(2)])}!${spot()}")`,
            () => `OFFSET(${fixed()},${1 + pick(3)},0)`,
            () => `OFFSET(${fixed()},${1 + pick(3)},0)`,
        ])()}`;
    const value = (): Literal | null =>
        of([() => pick(4), () => pick(4), () => pick(4), () => spelled(), () => of(NAMES), () => null, () => true])();
    return { pick, of, formula, value };
}

function shown(value: Literal | null): Literal | null {
    return typeof value === 'object' && value !== null ? value.text : value;
}

function run(seed: number, steps: number, counts: Counts): void {
    const { pick, of, formula, value } = generator(random(seed * 7919 + 13));
    const bump = (what: string) => {
        counts[what] = (counts[what] ?? 0) + 1;
    };
    let tabs: Tab[] = [
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
        { id: 'c', name: 'Gam ma' },
    ];
    let made = 0;
    let now = 45000;
    let clock = seed;
    const stored = (typed: string, row: number, column: number) => storedText(typed, row, column, sheetFinder(tabs));
    // The cells of a sheet, as they are typed: the formulas of one that is added are typed with it in the workbook.
    const typed = (dense: number): Cell[] => {
        const cells: Cell[] = [];
        for (let column = 0; column < COLUMNS; column += 1) {
            for (let row = 0; row < ROWS; row += 1) {
                const what = pick(100);
                if (what < dense) cells.push([row, column, null, formula()]);
                else if (what < dense + 35) cells.push([row, column, value(), null]);
            }
        }
        return cells;
    };
    const source = (tab: Tab, cells: readonly Cell[]): SheetSource => ({
        id: tab.id,
        name: tab.name,
        cells: (cell) => {
            for (const [row, column, held, text] of cells) {
                cell(row, column, held, text === null ? null : stored(text, row, column));
            }
        },
    });
    // What an engine holds, as a load takes it: with the values of its formulas or without.
    const walk = (from: Engine, values: boolean): SheetSource[] =>
        tabs.map(({ id, name }) => ({
            id,
            name,
            cells: (cell) =>
                from.cells(id, (row, column, held, text) =>
                    cell(row, column, text !== null && !values ? null : held, text),
                ),
        }));
    let engine = new Engine(
        tabs.map((tab) => source(tab, typed(30))),
        now,
        clock,
        false,
    );
    // Whether the passes ran to the end since the last step, and whether the engine may still flag every formula
    // that resolves at its next marking: after a computed load and after a refusal, until a marking is known.
    let finished = false;
    let unrecorded = false;
    let seeded = false;
    const passed = () => {
        if (seeded) unrecorded = false;
        seeded = false;
    };
    const compare = (step: number, what: string) => {
        while (engine.recalc(NO_CAP).stopped);
        passed();
        finished = true;
        const fresh = new Engine(walk(engine, false), now, clock, false);
        fresh.recalc(NO_CAP);
        bump('compares');
        for (const { id, name } of tabs) {
            const last = Math.max(engine.lastRow(id), fresh.lastRow(id));
            const wide = Math.max(engine.lastColumn(id), fresh.lastColumn(id));
            for (let column = 0; column <= wide; column += 1) {
                for (let row = 0; row <= last; row += 1) {
                    const held = shown(engine.valueOf(id, row, column));
                    const expected = shown(fresh.valueOf(id, row, column));
                    if (held === expected) continue;
                    const cell = `${name}!${letter(column)}${row + 1} ${engine.formulaOf(id, row, column)}`;
                    expect(`seed ${seed} step ${step} after ${what}: ${cell} holds ${held}`).toBe(
                        `seed ${seed} step ${step} after ${what}: ${cell} holds ${expected}`,
                    );
                }
            }
        }
    };
    // One number written to one cell of a finished engine whose records are whole, aimed half of the time at
    // the cell a probe resolved. A pass capped at 0 marks and computes the first formula it flagged, no other.
    const probe = (step: number) => {
        const probes: { id: string; row: number; column: number; reads: readonly number[] }[] = [];
        for (const { id } of tabs) {
            engine.cells(id, (row, column, _held, text) => {
                const found = text === null ? null : PROBE.exec(text);
                if (found === null) return;
                const [first, across, count] = found.slice(1).map(Number);
                // The cell it resolved, then the one it names: neither holds a formula, which a marking could flag.
                const reads = [first - 1 + count, across - 1, first - 1, across - 1];
                if (engine.formulaOf(id, reads[0], reads[1]) !== null) return;
                if (engine.formulaOf(id, reads[2], reads[3]) === null) probes.push({ id, row, column, reads });
            });
        }
        const aimed = probes.length > 0 && pick(2) === 0 ? of(probes) : null;
        const id = aimed?.id ?? of(tabs).id;
        const row = aimed?.reads[0] ?? pick(ROWS);
        const column = aimed?.reads[1] ?? pick(COLUMNS);
        if (engine.formulaOf(id, row, column) !== null) return;
        const written = 1000 + step;
        engine.setValue(id, row, column, written);
        engine.recalc(0);
        for (const host of probes) {
            const { reads } = host;
            const at = host.id === id ? [0, 2].find((i) => reads[i] === row && reads[i + 1] === column) : undefined;
            const pending = engine.isPending(host.id, host.row, host.column);
            const where = `seed ${seed} step ${step} ${host.id} ${host.row},${host.column}`;
            if (at === undefined) {
                expect(`${where} flagged ${pending}`).toBe(`${where} flagged false`);
                bump('a probe not flagged by a write elsewhere');
            } else if (at === 0) {
                const computed = engine.valueOf(host.id, host.row, host.column) === written;
                expect(`${where} flagged ${pending || computed}`).toBe(`${where} flagged true`);
                bump('a probe flagged by a write to its area');
            }
        }
    };
    compare(-1, 'the load');
    for (let step = 0; step < steps; step += 1) {
        const op = pick(100);
        const tab = of(tabs);
        let what = '';
        const exact = finished && !unrecorded && engine.settled();
        finished = false;
        try {
            if (op < 30) {
                what = 'setValue';
                seeded = true;
                if (exact) probe(step);
                else {
                    for (let writes = 1 + pick(3); writes > 0; writes -= 1) {
                        const written = value();
                        const at = of(tabs).id;
                        if (written === null) engine.clear(at, pick(ROWS), pick(COLUMNS));
                        else engine.setValue(at, pick(ROWS), pick(COLUMNS), written);
                    }
                }
            } else if (op < 36) {
                what = 'clear';
                seeded = true;
                engine.clear(tab.id, pick(ROWS), pick(COLUMNS));
            } else if (op < 46) {
                what = 'setFormula';
                const row = pick(ROWS);
                const column = pick(COLUMNS);
                seeded = true;
                engine.setFormula(tab.id, row, column, stored(formula(), row, column));
            } else if (op < 50) {
                what = 'fillFormula';
                const row = pick(ROWS - 3);
                const column = pick(COLUMNS - 1);
                seeded = true;
                engine.fillFormula(
                    tab.id,
                    row,
                    column,
                    row + pick(4),
                    column + pick(2),
                    stored(formula(), row, column),
                );
            } else if (op < 60) {
                what = 'editLines';
                const edit = { insert: pick(2) === 0, index: pick(ROWS), count: 1 + pick(2), sheet: tab.id };
                engine.editLines({ ...edit, rows: pick(3) > 0 });
                unrecorded = false;
            } else if (op < 66) {
                what = 'moveCells';
                engine.moveCells({
                    fromSheet: tab.id,
                    row: pick(ROWS),
                    column: pick(COLUMNS),
                    rows: 1 + pick(3),
                    columns: 1 + pick(2),
                    toSheet: of(tabs).id,
                    toRow: pick(ROWS),
                    toColumn: pick(COLUMNS),
                });
                unrecorded = false;
            } else if (op < 69) {
                what = 'addSheet';
                const free = NAMES.filter((name) => !tabs.some((held) => held.name === name));
                if (free.length > 0 && tabs.length < 5) {
                    made += 1;
                    const added = { id: `n${made}`, name: of(free) };
                    const place = pick(tabs.length + 1);
                    const cells = typed(20);
                    tabs = [...tabs.slice(0, place), added, ...tabs.slice(place)];
                    engine.addSheet(source(added, cells), place);
                    unrecorded = false;
                }
            } else if (op < 72) {
                what = 'removeSheet';
                if (tabs.length > 1) {
                    engine.removeSheet(tab.id);
                    tabs = tabs.filter((held) => held !== tab);
                    unrecorded = false;
                }
            } else if (op < 76) {
                what = 'renameSheet';
                const free = NAMES.filter((name) => !tabs.some((held) => held.name === name));
                if (free.length > 0) {
                    const name = of(free);
                    engine.renameSheet(tab.id, name);
                    tabs = tabs.map((held) => (held === tab ? { id: held.id, name } : held));
                    unrecorded = false;
                }
            } else if (op < 79) {
                what = 'moveSheet';
                const place = pick(tabs.length);
                engine.moveSheet(tab.id, place);
                const rest = tabs.filter((held) => held !== tab);
                tabs = [...rest.slice(0, place), tab, ...rest.slice(place)];
                unrecorded = false;
            } else if (op < 90) {
                // A batch that writes nothing, as one of formats, or the clock of the writes before it.
                what = 'setClock';
                now += pick(3) === 0 ? 0 : 0.01;
                clock = pick(2) === 0 ? clock : clock + 1;
                engine.setClock(now, clock);
            } else what = 'no write';
        } catch (thrown) {
            if (!(thrown instanceof EditRefusal)) throw thrown;
            unrecorded = true;
            what = 'an edit refused';
        }
        bump(what);
        // Then no pass, a capped pass, or passes to the end and a compare, after which a settled engine may be
        // loaded again as computed.
        const then = pick(10);
        if (then < 5) {
            bump('no pass before the next step');
            continue;
        }
        if (then < 7) {
            if (engine.recalc(1 + pick(6)).stopped) bump('a pass stopped');
            passed();
            continue;
        }
        compare(step, what);
        if (engine.settled() && pick(3) === 0) {
            engine = new Engine(walk(engine, true), now, clock, true);
            unrecorded = true;
            bump('a load as computed');
        }
    }
    compare(steps, 'the end');
}

describe('formulas that resolve a reference, held against a fresh load', () => {
    test('the generator writes formulas that parse', () => {
        const { formula } = generator(random(1));
        const tabs = NAMES.map((name) => ({ id: name, name }));
        for (let i = 0; i < 2000; i += 1) {
            expect(parseStored(storedText(formula(), 3, 3, sheetFinder(tabs)))).not.toHaveProperty('reason');
        }
    });

    const seeds = Number(process.env['RESOLVED_LAW_SEEDS'] ?? 300);
    const first = Number(process.env['RESOLVED_LAW_FIRST'] ?? 1);
    test(`after random writes, edits, clocks, capped passes and loads every cell equals a fresh recalc: ${seeds} seeds`, () => {
        const counts: Counts = {};
        for (let seed = first; seed < first + seeds; seed += 1) run(seed, 60, counts);
        if (process.env['RESOLVED_LAW_SEEDS'] !== undefined) console.log(JSON.stringify(counts));
        // Per 300 seeds, each floor about half of what they give.
        const floors: Counts = {
            compares: 4000,
            setValue: 2500,
            clear: 500,
            setFormula: 800,
            fillFormula: 300,
            editLines: 800,
            moveCells: 400,
            addSheet: 200,
            removeSheet: 200,
            renameSheet: 300,
            moveSheet: 200,
            setClock: 800,
            'no write': 800,
            'no pass before the next step': 4000,
            'a pass stopped': 1000,
            'a load as computed': 600,
            'a probe flagged by a write to its area': 250,
            'a probe not flagged by a write elsewhere': 700,
        };
        for (const [what, floor] of Object.entries(floors)) {
            expect([what, (counts[what] ?? 0) >= (floor * seeds) / 300]).toEqual([what, true]);
        }
    }, 600000);
});
