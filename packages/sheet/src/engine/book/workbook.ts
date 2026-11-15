// The state of one spreadsheet document on one host, such as a browser tab or the server. It holds the formula
// engine, which keeps the cells' values and formulas, one table of looks, and per sheet the bands that say which
// look a cell wears, the keys of its rows and columns, what its cells hold beyond a value, and its records. It is
// built from a decoded snapshot and walks back to one, so equal documents give equal snapshots whatever their
// history. The appliers of the ops reach the parts through it, and nothing outside this folder does.

import type { Literal } from '@workspace/formula';
import { Engine, errorOf } from '@workspace/formula';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import { compareRules } from '@workspace/lib/sheets';
import type { BookContent } from '@workspace/lib/sheets/book-codec';
import type { WorkbookWeight } from '@workspace/lib/sheets/limits';
import { fits } from '@workspace/lib/sheets/limits';
import type { CellRecord, Placed } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { Bands } from './bands';
import type { Extra } from './extras';
import { Extras, textOf } from './extras';
import { LineRuns } from './line-runs';
import { LookTable } from './look-table';
import { SheetRecords } from './records';

// The parts of one sheet. Its cells are the engine's, under the sheet's id, and its fields are its records'. A part
// takes the op of an act itself: `lines(op)` inserts or deletes lines, `wouldPush(op)` says whether an insert pushes
// something off the grid, and `move(op, source)` is called on the part a block lands on. `write`, `lines` and `move`
// return what they replaced, removed or covered, as the part's reads list it. Records plan an edit before it writes.
type BookSheet = {
    readonly bands: Bands;
    readonly rows: LineRuns;
    readonly columns: LineRuns;
    readonly extras: Extras;
    readonly records: SheetRecords;
};

// A look table that holds fewer looks is not swept: the looks no cell wears then cost next to nothing.
const SWEEP_FLOOR = 64;

export class Workbook {
    public readonly engine: Engine;
    // A look id is this table's, so it means the same look on every sheet, until the next sweep.
    public readonly looks = new LookTable();
    public readonly sheets: ReadonlyMap<string, BookSheet>;
    // The generation: it rises only when the document is replaced whole, never with an edit.
    public readonly g: number;
    private readonly now: number;
    private readonly seed: number;
    // How many looks the table held after its last sweep. The load ends with one, so it counts the looks in use.
    private swept = 0;

    // Loads a snapshot, weighing the limits on the bands as rebuilt and the cells as listed before the engine
    // allocates: a document over one throws its refusal. A cell's `spill` mark is dropped, as a band said twice is.
    public constructor({ g, now, seed, sheets }: Readonly<Omit<BookContent, 'computed'>>) {
        const ordered = sheets.toSorted((a, b) => compareRules(a.fields.order, a.id, b.fields.order, b.id));
        const bands = ordered.map(
            (sheet) =>
                new Bands(
                    sheet.bands,
                    sheet.looks.map((look) => this.looks.intern(look)),
                ),
        );
        const records = ordered.map(({ id, fields, records }) => new SheetRecords(id, fields, records));
        let slots = 0;
        for (const { cells } of ordered) {
            // The cells come in column order, so a column's last cell says how many slots the engine gives it.
            let column = -1;
            let length = 0;
            for (const [row, at, cell] of cells) {
                if (!reachesEngine(cell)) continue;
                if (at !== column) slots += length;
                column = at;
                length = row + 1;
            }
            slots += length;
        }
        const refusal = fits(weightOf(slots, bands, records));
        if (refusal) throw new Refusal(refusal);

        this.engine = new Engine(
            ordered.map(({ id, fields, cells }) => ({
                id,
                name: fields.name,
                cells: (cell) => {
                    for (const [row, column, record] of cells) {
                        if (!reachesEngine(record)) continue;
                        const { v, e, f, s } = record;
                        const value = s ? textOf(s) : e && typeof v === 'string' ? errorOf(v) : (v ?? null);
                        cell(row, column, value, f ?? null);
                    }
                },
            })),
            now,
            seed,
        );
        const held = new Map<string, BookSheet>();
        for (const [at, { id, cells, rows, columns }] of ordered.entries()) {
            const extras = new Extras();
            for (const [row, column, { s, link, qp }] of cells) {
                if (s || link || qp) extras.write(row, column, { s, link, qp });
            }
            held.set(id, {
                bands: bands[at],
                rows: new LineRuns(rows),
                columns: new LineRuns(columns),
                extras,
                records: records[at],
            });
        }
        this.sheets = held;
        this.g = g;
        this.now = now;
        this.seed = seed;
        this.sweep();
    }

    // The document as a snapshot holds it. A formula still to be computed is listed with the value it last held, so
    // a host walks only after a recalc that did not stop.
    public content(): Omit<BookContent, 'computed'> {
        const sheets = [...this.sheets].sort(([idA, a], [idB, b]) =>
            compareRules(a.records.fields.order, idA, b.records.fields.order, idB),
        );
        return {
            g: this.g,
            now: this.now,
            seed: this.seed,
            sheets: sheets.map(([id, { bands, rows, columns, extras, records }]) => {
                const cells: Placed<CellRecord>[] = [];
                const list = (
                    row: number,
                    column: number,
                    value: Literal | null,
                    formula: string | null,
                    extra?: Extra,
                ) => {
                    const cell: CellRecord = {};
                    if (extra?.s) cell.s = extra.s;
                    else if (value !== null && typeof value === 'object') {
                        cell.v = value.text;
                        cell.e = 1;
                    } else if (value !== null) cell.v = value;
                    if (formula !== null) cell.f = formula;
                    if (extra?.link) cell.link = extra.link;
                    if (extra?.qp) cell.qp = extra.qp;
                    cells.push([row, column, cell]);
                };
                // A cell that holds only a link or a mark is no cell of the engine's: it is listed in its place
                // among them.
                const marked = extras.content();
                let next = 0;
                const listMarkedBefore = (row: number, column: number) => {
                    for (; next < marked.length; next += 1) {
                        const [r, c, extra] = marked[next];
                        if (c > column || (c === column && r >= row)) return;
                        list(r, c, null, null, extra);
                    }
                };
                this.engine.cells(id, (row, column, value, formula) => {
                    listMarkedBefore(row, column);
                    const here = next < marked.length && marked[next][0] === row && marked[next][1] === column;
                    list(row, column, value, formula, here ? marked[next][2] : undefined);
                    if (here) next += 1;
                });
                listMarkedBefore(GRID_ROWS, GRID_COLUMNS);
                const look = bands.content();
                return {
                    id,
                    fields: records.fields,
                    cells,
                    looks: look.looks.map((id) => this.looks.look(id)),
                    bands: look.bands,
                    rows: rows.content(),
                    columns: columns.content(),
                    records: records.content(),
                };
            }),
        };
    }

    // What the limits count: the engine's slots, the runs and bands of every sheet, its records and the sheets.
    public weight(): WorkbookWeight {
        const sheets = [...this.sheets.values()];
        return weightOf(
            this.engine.slots(),
            sheets.map((sheet) => sheet.bands),
            sheets.map((sheet) => sheet.records),
        );
    }

    // Forgets the looks no cell wears once the table holds twice the looks its last sweep left, renumbering the rest in
    // every sheet's bands: an applier calls it once a batch is done, with no look id in hand.
    public sweepLooks(): void {
        if (this.looks.size > Math.max(SWEEP_FLOOR, 2 * this.swept)) this.sweep();
    }

    private sweep(): void {
        const worn = new Set<number>();
        for (const { bands } of this.sheets.values()) {
            for (const id of bands.content().looks) worn.add(id);
        }
        const moved = this.looks.sweep(worn);
        for (const { bands } of this.sheets.values()) {
            bands.write([0, 0, GRID_ROWS - 1, GRID_COLUMNS - 1], (id) => moved[id]);
        }
        this.swept = this.looks.size;
    }
}

function weightOf(slots: number, bands: readonly Bands[], records: readonly SheetRecords[]): WorkbookWeight {
    let runs = 0;
    let count = 0;
    for (const sheet of bands) {
        const weight = sheet.weight();
        runs += weight.runs;
        count += weight.bands;
    }
    const most = Math.max(0, ...records.map((sheet) => sheet.weight().records));
    return { slots, runs, bands: count, records: most, sheets: bands.length };
}

// A cell with a value, a formula or a rich text is the engine's; one with only a link or a mark is not.
function reachesEngine({ v, f, s }: CellRecord): boolean {
    return v !== undefined || f !== undefined || s !== undefined;
}
