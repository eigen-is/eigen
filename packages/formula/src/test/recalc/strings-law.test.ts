import { expect, spyOn, test } from 'bun:test';
import type { Literal, SheetSource } from '../../index';
import { Engine } from '../../index';
import { StringTable } from '../../store/strings';
import { columnLabel, parseA1, printStored, sheetFinder } from '../../text';
import { random } from '../store/support';

// The law of the string table's sweep: whatever was written, edited and recalculated, a cell that holds no formula
// reads after a pass what it read before it, and after a full pass every cell reads what a fresh engine computes
// from the same cells. The workbooks are small and their texts long, so the table passes its floor every few steps,
// and sheets come and go, so most passes begin with a sweep.

const NO_CAP = Number.POSITIVE_INFINITY;
const ROWS = 16;
const COLUMNS = 5;
// A text with this many characters behind it weighs with its key about a seventieth of the floor.
const PAD = 30_000;
const TAIL = 'p'.repeat(PAD);

// Texts whose keys are shared, are longer than they are or are not what upper case alone gives.
const WORDS = ['Yes', 'yes', 'YES', 'No', 'pear', 'Pear', 'k1', 'K1', 'straße', 'STRASSE', 'Straße', 'İ', 'i', 'ŉ'];
const SHORT = ['7', '5', ' 3.50', 'TRUE', '', 'co-op', 'COOP', '😀a', '😀A'];

// Filled down a column, every write to B2 makes a column of new long texts.
const FAN = '=LEFT($B$2,9)&ROW()&REPT("q",PAD)';

// #c a cell, #k a column, #K one column for the whole formula, #t a text, #n a small number.
const TEMPLATES = [
    '=#c&"-"&ROW()',
    '=$A$1&"/"&ROW()',
    '=LEFT(#c,9)&ROW()&REPT("Q",PAD)',
    '=UPPER(#c)',
    '=LOWER(#c)&"x"',
    '=IF(#c=#c,"Same","diff")',
    '=#c<#c',
    '=#c+1',
    '=LEN(#c)',
    '=COUNTIF(#k:#k,#t)',
    '=COUNTIF(#k1:#k16,#c)',
    '=COUNTIF(#k:#k,"<>"&#c)',
    '=COUNTIF(#k:#k,"k*")',
    '=COUNTIF(#k:#k,"<=Pear")',
    '=COUNTIF(#k:#k,#n)',
    '=SUMIF(#k1:#k16,#c,#k1:#k16)',
    '=COUNTIFS(#k:#k,#c,#k:#k,"<>"&#c)',
    '=SUMIFS(#k1:#k16,#k1:#k16,#c,#k1:#k16,#t)',
    '=MATCH(#c,#k1:#k16,0)',
    '=MATCH(#t,#k:#k,0)',
    '=VLOOKUP(#c,$A$1:$E$16,#n,0)',
    '=XMATCH(#c,#k1:#k16,0,-1)',
    '=INDEX(#k:#k,#n)',
    // A column asked more than once, so its index is built and then read.
    '=IFERROR(MATCH(#c,#K:#K,0),0)+IFERROR(MATCH(#t,#K:#K,0),0)+COUNTIF(#K:#K,#c)',
    '=IFERROR(MATCH(#c&"",#K:#K,0),0)+COUNTIF(#K:#K,#t)+COUNTIF(#K:#K,#c)',
];

type Named = { readonly id: string; name: string };
type Held = readonly [row: number, column: number, value: Literal | null, formula: string | null];
type Counts = { checks: number; passes: number; stopped: number; sweeps: number; grown: number };

function show(value: unknown): string {
    if (value === null) return '';
    if (typeof value === 'object' && 'text' in value) return `error:${String(value.text)}`;
    return `${typeof value}:${String(value)}`;
}

function runLaw(seed: number, books: number, steps: number): Counts {
    const keep = spyOn(StringTable.prototype, 'keep');
    const counts: Counts = { checks: 0, passes: 0, stopped: 0, sweeps: 0, grown: 0 };
    for (let book = 0; book < books; book += 1) {
        const next = random(seed * 100_003 + book);
        const pick = (n: number) => Math.floor(next() * n);
        const one = <T>(list: readonly T[]): T => list[pick(list.length)];
        const sheets: Named[] = [
            { id: 'one', name: 'One' },
            { id: 'two', name: 'Two' },
        ];
        // How far down and right a cell can have got: the block that is written, a moved block past it, and
        // every line inserted since.
        let rows = ROWS + 8;
        let columns = COLUMNS + 3;
        let made = 0;
        let removed = false;
        let step = 0;
        const fail = (what: string): never => {
            throw new Error(`seed ${seed} book ${book} step ${step}: ${what}`);
        };

        const cell = () => `${columnLabel(pick(COLUMNS))}${1 + pick(ROWS)}`;
        const text = (): string => {
            const drawn = pick(10);
            if (drawn < 2) return one(SHORT);
            if (drawn < 4) return one(WORDS);
            if (drawn < 8) return one(WORDS) + TAIL;
            made += 1;
            return `New ${made} ${TAIL}`;
        };
        const value = (): Literal => {
            const drawn = pick(10);
            return drawn < 3 ? pick(8) : drawn < 4 ? pick(2) === 0 : text();
        };
        const stored = (typed: string, row: number, column: number): string => {
            const tree = parseA1(typed, row, column, sheetFinder(sheets));
            return 'reason' in tree ? fail(`${typed}: ${tree.reason}`) : printStored(tree);
        };
        const formula = (row: number, column: number, template = one(TEMPLATES)): string => {
            const same = columnLabel(pick(COLUMNS));
            const typed = template.replaceAll('PAD', String(PAD)).replace(/#[ckKtn]/g, (mark) => {
                if (mark === '#c') return (pick(5) === 0 ? `'${one(sheets).name}'!` : '') + cell();
                if (mark === '#k') return columnLabel(pick(COLUMNS));
                if (mark === '#K') return same;
                if (mark === '#n') return String(1 + pick(COLUMNS));
                const word = `"${one([...WORDS, ...SHORT])}"`;
                return pick(2) === 0 ? word : `${word}&REPT("p",${PAD})`;
            });
            return stored(typed, row, column);
        };
        const source = (sheet: Named, cells: readonly Held[]): SheetSource => ({
            id: sheet.id,
            name: sheet.name,
            cells: (sink) => cells.forEach((held) => void sink(...held)),
        });
        const some = (count: number): Held[] =>
            Array.from({ length: count }, (): Held => {
                const row = pick(ROWS);
                const column = pick(COLUMNS);
                return pick(4) === 0 ? [row, column, null, formula(row, column)] : [row, column, value(), null];
            });

        const engine = new Engine(sheets.map((sheet) => source(sheet, some(40))));
        for (const { id } of sheets) engine.fillFormula(id, 0, 3, ROWS - 1, 4, formula(0, 3, FAN));
        // What every cell reads, and with `typed` only the cells that hold no formula.
        const read = (from: Engine, typed: boolean): string[] => {
            const all: string[] = [];
            for (const { id } of sheets) {
                for (let row = 0; row < rows; row += 1) {
                    for (let column = 0; column < columns; column += 1) {
                        const skip = typed && from.formulaOf(id, row, column) !== null;
                        all.push(skip ? '' : show(from.valueOf(id, row, column)));
                    }
                }
            }
            return all;
        };
        const same = (what: string, held: readonly string[], wanted: readonly string[]): void => {
            const at = held.findIndex((shown, i) => shown !== wanted[i]);
            if (at < 0) return;
            const sheet = sheets[Math.floor(at / (rows * columns))].name;
            const place = `${columnLabel(at % columns)}${1 + (Math.floor(at / columns) % rows)}`;
            fail(`${what}: ${sheet}!${place} reads ${held[at].slice(0, 60)}, not ${wanted[at].slice(0, 60)}`);
        };
        const pass = (cap: number): void => {
            const before = read(engine, true);
            const swept = keep.mock.calls.length;
            const { stopped } = engine.recalc(cap);
            counts.passes += 1;
            if (stopped) counts.stopped += 1;
            if (keep.mock.calls.length > swept) {
                counts.sweeps += 1;
                if (!removed) counts.grown += 1;
            }
            removed = false;
            same('a cell with no formula changed in a pass', read(engine, true), before);
        };

        for (step = 0; step < steps; step += 1) {
            for (const { id } of sheets) engine.setValue(id, 1, 1, `Hot ${step}`);
            for (let write = 1 + pick(6); write > 0; write -= 1) {
                const { id } = one(sheets);
                const row = pick(ROWS);
                const column = pick(COLUMNS);
                const kind = pick(1000);
                if (kind < 280) engine.setValue(id, row, column, value());
                else if (kind < 560) engine.setFormula(id, row, column, formula(row, column));
                else if (kind < 620) engine.clear(id, row, column);
                else if (kind < 700) {
                    const edit = { sheet: id, rows: true, insert: kind < 660, index: row, count: 1 + pick(2) };
                    if (edit.insert) rows += edit.count;
                    engine.editLines(edit);
                } else if (kind < 730) {
                    const insert = kind < 715;
                    if (insert) columns += 1;
                    engine.editLines({ sheet: id, rows: false, insert, index: column, count: 1 });
                } else if (kind < 800) {
                    const block = { fromSheet: id, row, column, rows: 1 + pick(8), columns: 1 + pick(3) };
                    engine.moveCells({ ...block, toSheet: one(sheets).id, toRow: pick(ROWS), toColumn: pick(COLUMNS) });
                } else if (kind < 840) {
                    const right = Math.min(COLUMNS - 1, column + pick(2));
                    if (pick(2) === 0) engine.fillFormula(id, 0, column, ROWS - 1, right, formula(0, column, FAN));
                    else
                        engine.fillFormula(
                            id,
                            row,
                            column,
                            Math.min(ROWS - 1, row + pick(5)),
                            right,
                            formula(row, column),
                        );
                } else if (kind < 860) {
                    const place = pick(sheets.length);
                    engine.moveSheet(id, place);
                    const at = sheets.findIndex((sheet) => sheet.id === id);
                    sheets.splice(place, 0, ...sheets.splice(at, 1));
                } else if (kind < 880) {
                    const sheet = one(sheets);
                    sheet.name = `Renamed${book}x${step}x${write}`;
                    engine.renameSheet(sheet.id, sheet.name);
                } else if (kind < 925) {
                    if (sheets.length === 1) continue;
                    sheets.splice(
                        sheets.findIndex((sheet) => sheet.id === id),
                        1,
                    );
                    engine.removeSheet(id);
                    removed = true;
                } else if (kind < 965) {
                    if (sheets.length === 4) continue;
                    const added = { id: `s${book}x${step}x${write}`, name: `Added${book}x${step}x${write}` };
                    const place = pick(sheets.length + 1);
                    sheets.splice(place, 0, added);
                    engine.addSheet(source(added, some(14)), place);
                    engine.fillFormula(added.id, 0, 4, ROWS - 1, 4, formula(0, 4, FAN));
                } else pass(1 + pick(10));
            }
            if (pick(10) < 4) {
                pass(1 + pick(8));
                if (pick(2) === 0) pass(1 + pick(3));
            }
            pass(NO_CAP);
            const cells = sheets.map((sheet) => {
                const held: Held[] = [];
                for (let row = 0; row < rows; row += 1) {
                    for (let column = 0; column < columns; column += 1) {
                        const written = engine.formulaOf(sheet.id, row, column);
                        const typed = written === null ? engine.valueOf(sheet.id, row, column) : null;
                        if (written !== null || typed !== null) held.push([row, column, typed, written]);
                    }
                }
                return source(sheet, held);
            });
            const fresh = new Engine(cells);
            fresh.recalc(NO_CAP);
            same('not what a fresh load computes', read(engine, false), read(fresh, false));
            counts.checks += 1;
        }
    }
    keep.mockRestore();
    return counts;
}

test('after every pass every cell reads what a fresh load of the same cells computes', () => {
    const counts = runLaw(1, 120, 30);
    expect(counts.checks).toBe(3600);
    // Sweeps in all, and those of them that no removed sheet asked for.
    expect(counts.sweeps).toBeGreaterThan(900);
    expect(counts.grown).toBeGreaterThan(500);
}, 300_000);
