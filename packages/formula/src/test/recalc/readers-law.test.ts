import { describe, expect, test } from 'bun:test';
import type { Literal, SheetSource } from '../../index';
import { EditRefusal, Engine } from '../../index';
import { sheetFinder, storedText } from '../../text';

// The truth law of who reads a sheet: an engine that went through random writes and edits holds, whenever its
// passes ran to the end, the values and the loops of an engine that loads the same cells fresh and computes them
// all. The books are small sheets whose formulas read each other across sheets, by reference, by a name no sheet
// has yet, by a reference worked out as they run and by the place of a sheet among the tabs, while the sheets they
// read are removed, added back under their id, renamed and moved, and new sheets shift every place. A book is
// loaded again as computed now and then and written before its first pass, and passes are capped.

const NO_CAP = Number.POSITIVE_INFINITY;
const ROWS = 7;
const COLUMNS = 5;
const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];
const NAMES = ['Alpha', 'Beta', 'Gam ma', 'Delta', 'Zed', 'Eps', 'Eta', 'Theta'];

type Held = readonly [row: number, column: number, value: Literal | null, formula: string | null];
type Tab = { id: string; name: string; hidden: number[]; filtered: number[] };
type Counts = Record<string, number>;

function random(seed: number): () => number {
    let a = seed | 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const label = (row: number, column: number) => `${String.fromCharCode(65 + column)}${row + 1}`;
const quoted = (name: string) => (name.includes(' ') ? `'${name}'` : name);
const shown = (value: Literal | null) => (typeof value === 'object' && value !== null ? value.text : value);

function run(seed: number, steps: number, counts: Counts): void {
    const next = random(seed * 104729 + 7);
    const pick = (n: number) => Math.floor(next() * n);
    const of = <T>(list: readonly T[]): T => list[pick(list.length)];
    const bump = (what: string, by = 1) => {
        counts[what] = (counts[what] ?? 0) + by;
    };
    let tabs: Tab[] = [];
    // The cells a removed sheet held, for the add that brings its id back.
    const removed = new Map<string, Held[]>();
    let now = 45000;
    let clock = 1;

    const cell = () => label(pick(ROWS), pick(COLUMNS));
    const range = () => {
        const row = pick(ROWS);
        const column = pick(COLUMNS);
        return `${label(row, column)}:${label(Math.min(ROWS - 1, row + pick(3)), Math.min(COLUMNS - 1, column + pick(2)))}`;
    };
    // A sheet name: one a tab has, mostly, or one no tab may have.
    const name = () => quoted(pick(5) === 0 ? of(NAMES) : of(tabs).name);
    const formula = (row: number, column: number): string => {
        const own = label(row, column);
        const kinds: (() => string)[] = [
            () => `=${cell()}+1`,
            () => `=$${cell().replace(/(\d)/, '$$$1')}*2`,
            () => `=SUM(${range()})`,
            () => `=SUM(${of(['A:A', 'B:C', '2:3'])})+${cell()}`,
            () => `=${name()}!${cell()}+1`,
            () => `=${name()}!${cell()}+${name()}!${cell()}`,
            () => `=SUM(${name()}!${range()})`,
            () => `=SUM(${name()}!$A:$B)`,
            () => `=INDIRECT("${name()}!${cell()}")`,
            () => `=SUM(OFFSET(${name()}!${cell()},${pick(2)},0,2,1))`,
            () => `=SUM(OFFSET(${cell()},1,0,2,1))`,
            () => `=SUBTOTAL(109,${name()}!${range()})`,
            () => `=SUBTOTAL(9,${range()})`,
            () => `=SHEET()+SHEETS()+${cell()}`,
            () => `=ROW()+COLUMN()+${cell()}`,
            () => `=NOW()+${name()}!${cell()}`,
            () => `=RAND()+${cell()}`,
            () => `=ISFORMULA(${cell()})`,
            () => `=${own}`,
            () => `=SUM(${of(tabs).name === 'Gam ma' ? 'Alpha' : quoted(of(tabs).name)}:${quoted(of(tabs).name)}!A1)`,
        ];
        const typed = of(kinds)();
        if (/![A-Z$]/.test(typed)) bump('cross-sheet formulas');
        return storedText(typed, row, column, sheetFinder(tabs));
    };
    const cellsOf = (count: number): Held[] => {
        const cells: Held[] = [];
        for (let i = 0; i < count; i += 1) {
            const row = pick(ROWS);
            const column = pick(COLUMNS);
            if (pick(3) === 0) cells.push([row, column, pick(9), null]);
            else cells.push([row, column, null, formula(row, column)]);
        }
        return cells;
    };
    const source = (tab: Tab, cells: readonly Held[]): SheetSource => ({
        id: tab.id,
        name: tab.name,
        hidden: tab.hidden,
        filtered: tab.filtered,
        cells: (sink) => {
            for (const held of cells) sink(...held);
        },
    });

    for (let s = 0; s < 3; s += 1) tabs.push({ id: IDS[s], name: NAMES[s], hidden: [], filtered: [] });
    let engine = new Engine(
        tabs.map((tab) => source(tab, cellsOf(8))),
        now,
        clock,
        false,
    );
    // The cells of every sheet, a formula with its value only for a load that trusts values, or when it is one
    // this build cannot evaluate, which keeps the value it has.
    const held = (computed: boolean) =>
        tabs.map((tab) => {
            const cells: Held[] = [];
            engine.cells(tab.id, (row, column, value, text) => {
                const kept = computed || text === null || engine.isGiven(tab.id, row, column);
                cells.push([row, column, kept ? value : null, text]);
            });
            return source(tab, cells);
        });
    const read = (from: Engine) =>
        tabs.map((tab) => {
            const values: string[] = [];
            from.cells(tab.id, (row, column, value) => void values.push(`${row},${column} ${shown(value)}`));
            return `${tab.id}: ${values.join(' | ')}`;
        });
    const loopsOf = (loops: readonly { sheet: string; row: number; column: number }[]) =>
        loops.map((loop) => `${loop.sheet} ${loop.row},${loop.column}`);

    let fresh = false;
    for (let step = 0; step < steps; step += 1) {
        const tab = of(tabs);
        const row = pick(ROWS);
        const column = pick(COLUMNS);
        const what = pick(30);
        const wasFresh = fresh;
        fresh = false;
        try {
            if (what < 4) engine.setValue(tab.id, row, column, pick(9));
            else if (what < 5) engine.clear(tab.id, row, column);
            else if (what < 10) engine.setFormula(tab.id, row, column, formula(row, column));
            else if (what < 11) {
                const text = formula(row, column);
                engine.fillFormula(tab.id, row, column, Math.min(ROWS, row + pick(3)), column + pick(2), text);
            } else if (what < 14) {
                engine.editLines({
                    sheet: tab.id,
                    rows: pick(2) === 0,
                    insert: pick(2) === 0,
                    index: pick(4),
                    count: 1,
                });
                bump('line edits');
            } else if (what < 16) {
                const to = of(tabs);
                engine.moveCells({
                    fromSheet: tab.id,
                    row,
                    column,
                    rows: 1 + pick(3),
                    columns: 1 + pick(2),
                    toSheet: to.id,
                    toRow: pick(ROWS),
                    toColumn: pick(COLUMNS),
                });
                bump(to === tab ? 'moves' : 'moves across sheets');
            } else if (what < 18 && tabs.length > 1) {
                const cells: Held[] = [];
                engine.cells(tab.id, (r, c, value, text) => {
                    cells.push([r, c, text === null || engine.isGiven(tab.id, r, c) ? value : null, text]);
                });
                engine.removeSheet(tab.id);
                removed.set(tab.id, cells);
                tabs = tabs.filter((other) => other !== tab);
                bump('sheets removed');
            } else if (what < 20) {
                const id = of(IDS.filter((free) => tabs.every((other) => other.id !== free)));
                if (id === undefined) continue;
                const added = { id, name: of(NAMES), hidden: [], filtered: [] };
                const back = removed.get(id);
                const place = pick(tabs.length + 1);
                tabs.splice(place, 0, added);
                try {
                    engine.addSheet(source(added, back !== undefined && pick(3) > 0 ? back : cellsOf(5)), place);
                } catch (thrown) {
                    tabs.splice(place, 1);
                    throw thrown;
                }
                bump(back === undefined ? 'sheets added' : 'sheets added back');
                if (place < tabs.length - 1) bump('places shifted by an add');
            } else if (what < 22) {
                const to = of(NAMES);
                engine.renameSheet(tab.id, to);
                tab.name = to;
                bump('renames');
            } else if (what < 24) {
                const place = pick(tabs.length);
                engine.moveSheet(tab.id, place);
                tabs = tabs.filter((other) => other !== tab);
                tabs.splice(place, 0, tab);
                bump('sheet moves');
            } else if (what < 25) {
                now += 1;
                clock += 1;
                engine.setClock(now, clock);
            } else if (what < 26) {
                tab.hidden = pick(2) === 0 ? [] : [row, row];
                tab.filtered = pick(2) === 0 ? [] : [1, 2];
                engine.setRowsOut(tab.id, tab.hidden, tab.filtered);
            } else if (what < 28) {
                if (engine.recalc(1 + pick(4)).stopped) bump('stopped passes');
                continue;
            }
            if (wasFresh && what < 26) bump('written before the first pass of a computed load');
        } catch (thrown) {
            if (!(thrown instanceof EditRefusal) && !(thrown instanceof Error && /in use/.test(thrown.message))) {
                throw thrown;
            }
            bump('refused');
            continue;
        }
        if (pick(3) > 0) continue;
        const before = engine.settled();
        const result = engine.recalc(NO_CAP);
        if (before) expect({ seed, step, changed: result.changed }).toEqual({ seed, step, changed: [] });
        expect({ seed, step, settled: engine.settled() }).toEqual({ seed, step, settled: true });
        const loaded = new Engine(held(false), now, clock, false);
        const loops = loopsOf(loaded.recalc(NO_CAP).loops);
        expect({ seed, step, values: read(engine) }).toEqual({ seed, step, values: read(loaded) });
        expect({ seed, step, loops: loopsOf(result.loops) }).toEqual({ seed, step, loops });
        bump('compares');
        if (new Set(result.loops.map((loop) => loop.sheet)).size > 1) bump('loops on several sheets');
        if (pick(6) === 0) {
            engine = new Engine(held(true), now, clock, true);
            fresh = true;
            bump('computed loads');
        }
    }
}

describe('who reads a sheet', () => {
    test('after random edits of cells and of sheets every value and loop equals a fresh load: 250 seeds', () => {
        const counts: Counts = {};
        for (let seed = 1; seed <= 250; seed += 1) run(seed, 200, counts);
        const floors: Counts = {
            compares: 11000,
            'cross-sheet formulas': 6500,
            'line edits': 3800,
            moves: 1100,
            'moves across sheets': 1200,
            'sheets removed': 2000,
            'sheets added': 500,
            'sheets added back': 1400,
            'places shifted by an add': 1200,
            renames: 2000,
            'sheet moves': 2400,
            'stopped passes': 1400,
            'computed loads': 1800,
            'written before the first pass of a computed load': 1500,
            'loops on several sheets': 3400,
            refused: 1300,
        };
        for (const [what, floor] of Object.entries(floors)) {
            expect({ what, enough: (counts[what] ?? 0) >= floor }).toEqual({ what, enough: true });
        }
    }, 120_000);
});
