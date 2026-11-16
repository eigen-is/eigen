import { describe, expect, test } from 'bun:test';
import type { Literal, SheetSource } from '../../index';
import { EditRefusal, Engine } from '../../index';
import { GRID_COLUMNS, sheetFinder, storedText } from '../../text';

// The truth law of what the recalc keeps between edits: the blocks of formulas of each sheet, which a rebuild finds
// again only on the sheets an edit named or rewrote, and the count of flagged formulas of each sheet. A workbook of
// narrow sheets and of sheets that reach the last columns, whose formulas read across sheets, resolve references
// and leave rows out, goes through every door of the engine and the inverse of each. Whenever its passes ran to
// the end, every cell and the loops equal those of a fresh load of the same cells, which finds every block and
// counts every flag from scratch. And `settled()` says true exactly when no pass is owed: after a pass that ran
// to the end, with no formula flagged and every value already that of the fresh load, and never after a write, an
// edit, a clock, other rows left out or a pass that stopped.

const NO_CAP = Number.POSITIVE_INFINITY;
const ROWS = 10;
const NEAR = 6;
const FAR = 3;
const NAMES = ['Alpha', 'Beta', 'Gam ma', 'Wide', 'Far', 'Delta', 'Eps'];

type Tab = { readonly id: string; readonly name: string };
type Cell = readonly [row: number, column: number, value: Literal | null, formula: string | null];
type Counts = Record<string, number>;
// An edit that went through, and the edit that takes it back.
type Done = { readonly what: string; readonly back: () => void };

const quoted = (name: string) => (/^[A-Za-z]+$/.test(name) ? name : `'${name}'`);

function letters(column: number): string {
    let text = '';
    for (let left = column + 1; left > 0; left = Math.floor((left - 1) / 26)) {
        text = String.fromCharCode(65 + ((left - 1) % 26)) + text;
    }
    return text;
}

function random(seed: number): () => number {
    let a = seed | 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shown(value: Literal | null): Literal | null {
    return typeof value === 'object' && value !== null ? value.text : value;
}

function run(seed: number, steps: number, counts: Counts): void {
    const next = random(seed * 7919 + 13);
    const pick = (n: number) => Math.floor(next() * n);
    const of = <T>(list: readonly T[]): T => list[pick(list.length)];
    const bump = (what: string, by = 1) => {
        counts[what] = (counts[what] ?? 0) + by;
    };
    // A column of the first ones or, one time in four, of the last ones of the grid.
    const far = () => GRID_COLUMNS - 1 - pick(FAR);
    const column = () => (pick(4) === 0 ? far() : pick(NEAR));
    const row = () => pick(ROWS);
    const spot = (c = column()) => `${pick(4) === 0 ? '$' : ''}${letters(c)}${pick(4) === 0 ? '$' : ''}${1 + row()}`;
    const other = () => {
        bump('a reference to another sheet drawn');
        return `${quoted(of(NAMES))}!`;
    };
    const ref = () => (pick(3) === 0 ? `${other()}${spot()}` : spot());
    const range = () => {
        const left = pick(3) === 0 ? far() - 1 : pick(NEAR - 1);
        const top = pick(ROWS - 2);
        return `${pick(3) === 0 ? other() : ''}${letters(left)}${1 + top}:${letters(left + pick(2))}${2 + top + pick(3)}`;
    };
    const lines = () => {
        const c = letters(column());
        return of([`${c}:${c}`, `${1 + row()}:${1 + row()}`, `${other()}${c}:${c}`]);
    };
    const count = () => of([`${pick(3)}`, `${pick(3)}`, ref(), 'ROW()-1']);
    const resolving = (): string => {
        bump('a formula that resolves a reference drawn');
        return of([
            () => `OFFSET(${ref()},${count()},${count()})`,
            () => `OFFSET(${range()},${count()},0)`,
            () => `INDIRECT("${quoted(of(NAMES))}!${letters(column())}${1 + row()}")`,
            () => `INDIRECT("${quoted(of(NAMES))}!${letters(column())}"&(${count()}+1))`,
            () => `INDIRECT(${ref()})`,
            () => `INDEX(${range()},1,1):${spot()}`,
        ])();
    };
    const chooser = (): string => {
        bump('a formula that leaves rows out drawn');
        return of([
            () => `SUBTOTAL(109,${range()})`,
            () => `SUBTOTAL(9,${range()},${range()})`,
            () => `SUBTOTAL(103,${resolving()})`,
            () => `AGGREGATE(9,5,${range()})`,
        ])();
    };
    const formula = (): string =>
        `=${of([
            () => `${ref()}+1`,
            () => `${ref()}+${ref()}`,
            () => `${ref()}+${ref()}`,
            () => `SUM(${range()})`,
            () => `SUM(${range()})+${ref()}`,
            () => `COUNT(${lines()})`,
            () => `SUM(${lines()})`,
            () => `IF(${ref()}>1,${ref()},${ref()})`,
            () => `SUM(${resolving()})`,
            () => `IFERROR(${resolving()},7)`,
            () => chooser(),
            () => chooser(),
            () => 'RANDBETWEEN(0,3)',
            () => `ROW()+COLUMN()+${ref()}`,
            () => `SHEET()+SHEETS()+${ref()}`,
        ])()}`;
    const value = (): Literal | null =>
        of([() => pick(4), () => pick(4), () => pick(4), () => `${letters(pick(NEAR))}${1 + row()}`, () => true])();

    let tabs: Tab[] = NAMES.slice(0, 5).map((name, at) => ({ id: 'abcwx'[at], name }));
    // The sheets that went, with their cells as they were stored, to come back under their id.
    let gone: { tab: Tab; cells: Cell[] }[] = [];
    let made = 0;
    let now = 45000;
    let clock = seed;
    const out = new Map<string, readonly [hidden: number[], filtered: number[]]>();
    const stored = (typed: string, r: number, c: number) => storedText(typed, r, c, sheetFinder(tabs));
    // The cells of a sheet as they are typed, stored: the two last sheets of the first five reach the last columns.
    const typed = (wide: boolean): Cell[] => {
        const cells: Cell[] = [];
        const columns = Array.from({ length: NEAR }, (_, c) => c);
        if (wide) for (let c = GRID_COLUMNS - FAR; c < GRID_COLUMNS; c += 1) columns.push(c);
        for (const c of columns) {
            for (let r = 0; r < ROWS; r += 1) {
                const what = pick(100);
                if (what < 22) {
                    cells.push([r, c, null, stored(formula(), r, c)]);
                    if (c >= NEAR) bump('a formula on the last columns');
                } else if (what < 55) cells.push([r, c, value(), null]);
            }
        }
        return cells;
    };
    const source = (tab: Tab, cells: readonly Cell[]): SheetSource => ({
        id: tab.id,
        name: tab.name,
        cells: (cell) => {
            for (const [r, c, held, text] of cells) cell(r, c, held, text);
        },
    });
    const dump = (from: Engine, id: string, values: boolean): Cell[] => {
        const cells: Cell[] = [];
        from.cells(id, (r, c, held, text) => cells.push([r, c, text !== null && !values ? null : held, text]));
        return cells;
    };
    // What an engine holds, as a load takes it: with the values of its formulas or without, and its rows left out.
    const walk = (from: Engine, values: boolean): SheetSource[] =>
        tabs.map((tab) => {
            const [hidden, filtered] = out.get(tab.id) ?? [[], []];
            return { ...source(tab, dump(from, tab.id, values)), hidden, filtered };
        });
    let engine = new Engine(
        tabs.map((tab, at) => source(tab, typed(at >= 3))),
        now,
        clock,
        false,
    );
    const held = (from: Engine): Map<string, Literal | null> => {
        const cells = new Map<string, Literal | null>();
        for (const { id } of tabs) {
            from.cells(id, (r, c, at) => {
                if (at !== null) cells.set(`${id}!${r},${c}`, shown(at));
            });
        }
        return cells;
    };
    const fail = (step: number, what: string, said: string): never => {
        throw new Error(`seed ${seed} step ${step} after ${what}: ${said}`);
    };
    // The engine against a fresh load of its cells that ran one full pass.
    const against = (step: number, what: string, loops: readonly { sheet: string; row: number; column: number }[]) => {
        const fresh = new Engine(walk(engine, false), now, clock, false);
        const expected = fresh.recalc(NO_CAP);
        const mine = held(engine);
        const theirs = held(fresh);
        for (const key of new Set([...mine.keys(), ...theirs.keys()])) {
            if (mine.get(key) !== theirs.get(key)) {
                const [id, place] = key.split('!');
                const [r, c] = place.split(',').map(Number);
                const text = engine.formulaOf(id, r, c);
                fail(step, what, `${key} ${text} holds ${mine.get(key)}, fresh ${theirs.get(key)}`);
            }
        }
        bump('values held against a fresh load', mine.size);
        const listed = (cells: typeof loops) => cells.map((cell) => `${cell.sheet}!${cell.row},${cell.column}`).sort();
        if (listed(loops).join(' ') !== listed(expected.loops).join(' ')) {
            fail(step, what, `loops ${listed(loops).join(' ')}, fresh ${listed(expected.loops).join(' ')}`);
        }
        bump('cells on a loop listed', loops.length);
        for (const { id } of tabs) {
            engine.cells(id, (r, c) => {
                if (engine.isPending(id, r, c)) fail(step, what, `${id} ${r},${c} is flagged`);
            });
        }
    };
    let loops: readonly { sheet: string; row: number; column: number }[] = [];
    const compare = (step: number, what: string) => {
        let result = engine.recalc(NO_CAP);
        while (result.stopped) result = engine.recalc(NO_CAP);
        ({ loops } = result);
        if (!engine.settled()) fail(step, what, 'not settled after a pass that ran to the end');
        against(step, what, loops);
        bump('compares');
    };
    // Whether a pass is owed for sure: something went through since the last pass that ran to the end.
    let owed = false;
    const settled = (step: number, what: string) => {
        const said = engine.settled();
        if (owed && said) fail(step, what, 'settled with a pass owed');
        if (!said) return bump('settled said false');
        // No pass is run: what the engine holds is already what a fresh load computes.
        against(step, what, loops);
        bump('settled said true and no pass was owed');
    };

    const lineEdit = (tab: Tab): Done => {
        const onRows = pick(2) === 0;
        const index = onRows ? pick(ROWS + 2) : column();
        const edit = { sheet: tab.id, rows: onRows, index, count: 1 + pick(2) };
        const insert = pick(2) === 0;
        engine.editLines({ ...edit, insert });
        const what = `${insert ? 'an insert' : 'a delete'} of ${onRows ? 'rows' : 'columns'}`;
        return { what, back: () => engine.editLines({ ...edit, insert: !insert }) };
    };
    const move = (tab: Tab): Done => {
        const to = pick(3) === 0 ? of(tabs) : tab;
        const columns = 1 + pick(2);
        const at = Math.min(column(), GRID_COLUMNS - columns);
        const toColumn = Math.min(column(), GRID_COLUMNS - columns);
        const block = { row: row(), column: at, rows: 1 + pick(3), columns };
        const toRow = row();
        engine.moveCells({ ...block, fromSheet: tab.id, toSheet: to.id, toRow, toColumn });
        const back = { ...block, row: toRow, column: toColumn, fromSheet: to.id, toSheet: tab.id };
        return {
            what: to === tab ? 'a move' : 'a move across sheets',
            back: () => engine.moveCells({ ...back, toRow: block.row, toColumn: block.column }),
        };
    };
    const remove = (tab: Tab): Done | null => {
        if (tabs.length < 2) return null;
        const place = tabs.indexOf(tab);
        const cells = dump(engine, tab.id, true);
        engine.removeSheet(tab.id);
        tabs = tabs.filter((at) => at !== tab);
        gone = [...gone, { tab, cells }];
        out.delete(tab.id);
        return {
            what: 'a sheet removed',
            back: () => {
                // Under the name it had, unless a sheet took it since.
                const free = tabs.every((at) => at.name !== tab.name);
                const again = free ? tab : { id: tab.id, name: `Back${(made += 1)}` };
                engine.addSheet(source(again, cells), place);
                tabs = [...tabs.slice(0, place), again, ...tabs.slice(place)];
                gone = gone.filter((at) => at.tab !== tab);
            },
        };
    };
    const add = (): Done | null => {
        const place = pick(tabs.length + 1);
        const back = gone.filter((at) => tabs.every((tab) => tab.name !== at.tab.name));
        const free = NAMES.filter((name) => [...tabs, ...gone.map((at) => at.tab)].every((at) => at.name !== name));
        let added: Tab;
        if (back.length > 0 && pick(3) > 0) {
            const again = of(back);
            added = again.tab;
            engine.addSheet(source(added, again.cells), place);
            gone = gone.filter((at) => at !== again);
        } else if (free.length > 0 && tabs.length < 7) {
            added = { id: `n${(made += 1)}`, name: of(free) };
            // Its formulas are typed with the sheet in the workbook.
            const before = tabs;
            tabs = [...tabs, added];
            const cells = typed(pick(3) === 0);
            tabs = before;
            engine.addSheet(source(added, cells), place);
        } else return null;
        tabs = [...tabs.slice(0, place), added, ...tabs.slice(place)];
        return {
            what: added.id.startsWith('n') ? 'a sheet added' : 'a sheet added back',
            back: () => {
                gone = [...gone, { tab: added, cells: dump(engine, added.id, true) }];
                engine.removeSheet(added.id);
                tabs = tabs.filter((at) => at !== added);
                out.delete(added.id);
            },
        };
    };
    const rename = (tab: Tab): Done | null => {
        const free = NAMES.filter((name) => tabs.every((at) => at.name !== name));
        if (free.length === 0) return null;
        const named = (name: string) => {
            const place = tabs.findIndex((at) => at.id === tab.id);
            engine.renameSheet(tab.id, name);
            tabs = tabs.map((at, s) => (s === place ? { id: tab.id, name } : at));
        };
        named(of(free));
        return { what: 'a sheet renamed', back: () => named(tab.name) };
    };
    const reorder = (tab: Tab): Done => {
        const placed = (place: number) => {
            const at = tabs.findIndex((one) => one.id === tab.id);
            const moved = tabs[at];
            engine.moveSheet(tab.id, place);
            const rest = tabs.filter((one) => one !== moved);
            tabs = [...rest.slice(0, place), moved, ...rest.slice(place)];
        };
        const from = tabs.indexOf(tab);
        placed(pick(tabs.length));
        return { what: 'a sheet moved', back: () => placed(from) };
    };
    const leaveOut = (tab: Tab): Done => {
        const before = out.get(tab.id) ?? [[], []];
        const rows = (): number[] => {
            const first = pick(ROWS);
            return pick(3) === 0 ? [] : [first, first + pick(3)];
        };
        // Other rows left out are a change; the same ones are none.
        const say = (hidden: number[], filtered: number[]) => {
            const [had, sieved] = out.get(tab.id) ?? [[], []];
            if (`${had}|${sieved}` !== `${hidden}|${filtered}`) owed = true;
            engine.setRowsOut(tab.id, hidden, filtered);
            out.set(tab.id, [hidden, filtered]);
        };
        say(rows(), rows());
        return { what: 'rows left out', back: () => say(before[0], before[1]) };
    };

    compare(-1, 'the load');
    for (let step = 0; step < steps; step += 1) {
        const op = pick(100);
        const tab = of(tabs);
        let what = 'no write';
        let done: Done | null = null;
        try {
            if (op < 20) {
                what = 'a typed value';
                for (let writes = 1 + pick(3); writes > 0; writes -= 1) {
                    engine.setValue(of(tabs).id, row(), column(), value() ?? 0);
                }
            } else if (op < 25) {
                what = 'a clear';
                engine.clear(tab.id, row(), column());
            } else if (op < 35) {
                what = 'a typed formula';
                const [r, c] = [row(), column()];
                engine.setFormula(tab.id, r, c, stored(formula(), r, c));
                if (c >= NEAR) bump('a formula on the last columns');
            } else if (op < 40) {
                what = 'a fill';
                const [r, c] = [pick(ROWS - 3), Math.min(column(), GRID_COLUMNS - 2)];
                engine.fillFormula(tab.id, r, c, r + pick(4), c + pick(2), stored(formula(), r, c));
            } else if (op < 54) done = lineEdit(tab);
            else if (op < 64) done = move(tab);
            else if (op < 70) done = add();
            else if (op < 75) done = remove(tab);
            else if (op < 80) done = rename(tab);
            else if (op < 85) done = reorder(tab);
            else if (op < 91) done = leaveOut(tab);
            else if (op < 96) {
                what = 'a clock';
                now += pick(3) === 0 ? 0 : 0.01;
                clock += pick(2);
                engine.setClock(now, clock);
            }
            if (done !== null) ({ what } = done);
            if (what !== 'no write' && what !== 'rows left out') owed = true;
        } catch (thrown) {
            if (!(thrown instanceof EditRefusal)) throw thrown;
            what = 'an edit refused';
            done = null;
        }
        bump(what);
        settled(step, what);
        // Then no pass, a pass that may stop, or passes to the end and a compare.
        const then = pick(10);
        if (then < 3) bump('no pass before the next step');
        else if (then < 5) {
            const result = engine.recalc(1 + pick(6));
            ({ loops } = result);
            if (result.stopped) {
                owed = true;
                bump('a pass stopped');
            } else owed = false;
            settled(step, 'a capped pass');
        } else {
            compare(step, what);
            owed = false;
            if (pick(6) === 0) {
                // A load as computed, and half of the time a write before its first pass.
                engine = new Engine(walk(engine, true), now, clock, true);
                bump('a load as computed');
                settled(step, 'a load as computed');
                continue;
            }
        }
        if (done === null || pick(3) > 0) continue;
        try {
            done.back();
            if (done.what !== 'rows left out') owed = true;
            bump(`${done.what} taken back`);
            settled(step, `${done.what} taken back`);
            if (pick(2) === 0) {
                compare(step, `${done.what} taken back`);
                owed = false;
            }
        } catch (thrown) {
            if (!(thrown instanceof EditRefusal)) throw thrown;
            bump('an edit refused');
        }
    }
    compare(steps, 'the end');
}

describe('what the recalc keeps between edits equals what a fresh load builds', () => {
    const seeds = Number(process.env['WALKS_LAW_SEEDS'] ?? 100);
    const first = Number(process.env['WALKS_LAW_FIRST'] ?? 1);
    test(`after every door and its inverse every cell, the loops and settled() equal a fresh load: ${seeds} seeds`, () => {
        const counts: Counts = {};
        for (let seed = first; seed < first + seeds; seed += 1) run(seed, 50, counts);
        if (process.env['WALKS_LAW_SEEDS'] !== undefined) console.log('walks law', JSON.stringify(counts));
        // Per 150 seeds, each floor about half of what they give.
        const floors: Counts = {
            'a reference to another sheet drawn': 4400,
            'a formula that resolves a reference drawn': 1300,
            'a formula that leaves rows out drawn': 1000,
            'a formula on the last columns': 1300,
            'values held against a fresh load': 470_000,
            'cells on a loop listed': 13_000,
            compares: 2300,
            'a move': 280,
            'settled said false': 5200,
            'no pass before the next step': 1100,
            'an insert of rows': 130,
            'a sheet added': 140,
            'a clear': 170,
            'a typed value': 710,
            'a pass stopped': 700,
            'a typed formula': 380,
            'a fill': 180,
            'no write': 210,
            'a sheet moved': 190,
            'rows left out': 240,
            'a load as computed': 310,
            'a move across sheets': 93,
            'a delete of rows': 120,
            'a move taken back': 88,
            'a sheet removed': 190,
            'a sheet removed taken back': 58,
            'a sheet renamed': 170,
            'a sheet added taken back': 46,
            'a delete of columns': 130,
            'settled said true and no pass was owed': 190,
            'an edit refused': 60,
            'an insert of rows taken back': 43,
            'a delete of rows taken back': 36,
            'a sheet renamed taken back': 55,
            'a sheet moved taken back': 62,
            'a clock': 180,
            'rows left out taken back': 79,
            'a delete of columns taken back': 42,
            'an insert of columns': 67,
            'a sheet added back': 44,
            'a move across sheets taken back': 26,
            'an insert of columns taken back': 22,
            'a sheet added back taken back': 15,
        };
        for (const [what, floor] of Object.entries(floors)) {
            expect([what, (counts[what] ?? 0) >= (floor * seeds) / 150]).toEqual([what, true]);
        }
    }, 600000);
});
