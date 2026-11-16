// The state of one spreadsheet document on one host, such as a browser tab or the server: the formula engine, which
// keeps the cells' values and formulas, one table of looks, and per sheet the bands that say which look a cell wears,
// the keys of its rows and columns, what its cells hold beyond a value, and its records. It is built from a decoded
// snapshot and walks back to one, so equal documents give equal snapshots once computed, whatever their history. It
// tells the engine which rows a sheet hides and filters. Only the appliers in this folder reach the parts through it.

import type { EditResult, Literal, SheetSource } from '@workspace/formula';
import { Engine, errorOf } from '@workspace/formula';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import { compareRules } from '@workspace/lib/sheets';
import type { BookContent } from '@workspace/lib/sheets/book-codec';
import type { WorkbookWeight } from '@workspace/lib/sheets/limits';
import { fits } from '@workspace/lib/sheets/limits';
import type { CellRecord, Placed, SheetContent, Span } from '@workspace/lib/sheets/ops';
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
export type BookSheet = {
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
    // In tab order, as the engine holds them, so every reader walks the sheets in one order whatever its history.
    private parts = new Map<string, BookSheet>();
    // The generation: it rises only when the document is replaced whole, never with an edit.
    public readonly g: number;
    // The clock of the last batch that landed, or of the snapshot: its author's time and the seed of its draws.
    private now: number;
    private seed: number;
    // How many looks the table held after its last sweep. The load ends with one, so it counts the looks in use.
    private swept = 0;

    // Loads a snapshot, weighing the limits on the bands as rebuilt, the extras as held and the cells as listed
    // before the engine allocates: a document over one throws its refusal. A cell's `spill` mark is dropped, as a
    // band said twice is.
    public constructor({ g, now, seed, computed, sheets }: Readonly<BookContent>) {
        const ordered = sheets.toSorted((a, b) => compareRules(a.fields.order, a.id, b.fields.order, b.id));
        const parts = ordered.map((sheet) => this.partsOf(sheet));
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
        const refusal = fits(weightOf(slots, parts));
        if (refusal) throw new Refusal(refusal);

        // The rows a sheet hides and filters come with its cells, as the values of a computed load were computed
        // with them.
        const sources = ordered.map((sheet, at) => ({ ...sourceOf(sheet), ...rowsOut(parts[at]) }));
        this.engine = new Engine(sources, now, seed, computed);
        for (const [at, { id }] of ordered.entries()) this.parts.set(id, parts[at]);
        this.g = g;
        this.now = now;
        this.seed = seed;
        this.sweep();
    }

    public get sheets(): ReadonlyMap<string, BookSheet> {
        return this.parts;
    }

    // The document as a snapshot holds it. It says it is computed exactly when the engine's values are those of a
    // finished pass, so a host writes what this gives and a snapshot cannot say more than is true.
    public content(): BookContent {
        return {
            g: this.g,
            now: this.now,
            seed: this.seed,
            computed: this.engine.settled(),
            sheets: [...this.parts].map(([id, sheet]) => this.sheetContent(id, sheet)),
        };
    }

    // One sheet whole, as the snapshot lists it and a `sheet` op adds it.
    public sheetContent(id: string, { bands, rows, columns, extras, records }: BookSheet): SheetContent {
        const cells: Placed<CellRecord>[] = [];
        const list = (row: number, column: number, value: Literal | null, formula: string | null, extra?: Extra) => {
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
        // A cell that holds only a link or a mark is no cell of the engine's: it is listed in its place among them.
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
            looks: look.looks.map((at) => this.looks.look(at)),
            bands: look.bands,
            rows: rows.content(),
            columns: columns.content(),
            records: records.content(),
        };
    }

    // Adds a sheet as the load builds one, in its place among the tabs. The engine takes it first, and refuses it
    // with nothing written; it hands back the formulas of the other sheets that the sheet's name bound.
    public addSheet(sheet: SheetContent): EditResult {
        let place = 0;
        for (const [id, { records }] of this.parts) {
            if (compareRules(records.fields.order, id, sheet.fields.order, sheet.id) < 0) place += 1;
        }
        const result = this.engine.addSheet(sourceOf(sheet), place);
        this.place(sheet.id, this.partsOf(sheet), place);
        return result;
    }

    // A sheet's new place among the tabs, from 0, once its order says so: the engine reads a sheet by its place.
    public moveSheet(id: string, place: number): void {
        this.engine.moveSheet(id, place);
        const part = this.parts.get(id);
        if (part) this.place(id, part, place);
    }

    // Its looks stay in the table until the next sweep.
    public removeSheet(id: string): void {
        this.engine.removeSheet(id);
        this.parts.delete(id);
    }

    // The clock of a batch, which the host hands over once the batch's ops are applied: a refused batch throws
    // before that, so it leaves the clock of the batch before it.
    public setClock(now: number, seed: number): void {
        this.engine.setClock(now, seed);
        this.now = now;
        this.seed = seed;
    }

    // Says to the engine the rows every sheet hides and filters now. It moves none with an edit and takes an added
    // sheet with none, so the frame calls this at the end of a batch that can have changed them.
    public setRowsOut(): void {
        for (const [id, part] of this.parts) {
            const { hidden, filtered } = rowsOut(part);
            this.engine.setRowsOut(id, hidden, filtered);
        }
    }

    // What the limits count: the engine's slots, the runs, bands and extras of every sheet, its records, the sheets.
    public weight(): WorkbookWeight {
        return weightOf(this.engine.slots(), [...this.parts.values()]);
    }

    // Forgets the looks no cell wears once the table holds twice the looks its last sweep left, renumbering the rest in
    // every sheet's bands: an applier calls it once a batch is done, with no look id in hand.
    public sweepLooks(): void {
        if (this.looks.size > Math.max(SWEEP_FLOOR, 2 * this.swept)) this.sweep();
    }

    // A sheet's parts, its looks interned into the table and its bands rebuilt in the one form whatever it said.
    private partsOf({ id, fields, cells, looks, bands, rows, columns, records }: SheetContent): BookSheet {
        const extras = new Extras();
        for (const [row, column, { s, link, qp }] of cells) {
            if (s || link || qp) extras.write(row, column, { s, link, qp });
        }
        return {
            bands: new Bands(
                bands,
                looks.map((look) => this.looks.intern(look)),
            ),
            rows: new LineRuns(rows),
            columns: new LineRuns(columns),
            extras,
            records: new SheetRecords(id, fields, records),
        };
    }

    private place(id: string, part: BookSheet, place: number): void {
        const others = [...this.parts].filter(([other]) => other !== id);
        this.parts = new Map([...others.slice(0, place), [id, part], ...others.slice(place)]);
    }

    private sweep(): void {
        const worn = new Set<number>();
        for (const { bands } of this.parts.values()) {
            for (const id of bands.content().looks) worn.add(id);
        }
        const moved = this.looks.sweep(worn);
        for (const { bands } of this.parts.values()) {
            bands.write([0, 0, GRID_ROWS - 1, GRID_COLUMNS - 1], (id) => moved[id]);
        }
        this.swept = this.looks.size;
    }
}

function weightOf(slots: number, sheets: readonly BookSheet[]): WorkbookWeight {
    let runs = 0;
    let bands = 0;
    let extras = 0;
    let records = 0;
    for (const sheet of sheets) {
        const looks = sheet.bands.weight();
        runs += looks.runs;
        bands += looks.bands;
        extras += sheet.extras.weight();
        records = Math.max(records, sheet.records.weight().records);
    }
    return { slots, runs, bands, extras, records, sheets: sheets.length };
}

// The rows SUBTOTAL and AGGREGATE leave out, as the engine takes them: those a person hid and those the columns of
// the sheet's filter left out. While the filter leaves a row out, Excel counts every hidden row of the sheet as
// filtered, inside its range or not. A hidden column matters to neither function.
function rowsOut({ rows, records }: BookSheet): { hidden: number[]; filtered: number[] } {
    const hidden = rows.content().flatMap(([span, attrs]) => (attrs.hidden ? [span] : []));
    const filters = records.records('filter');
    const filtered = [...records.records('filterColumn').values()].flatMap((column) =>
        filters.has(column.filter) ? column.rows : [],
    );
    if (filtered.length > 0) filtered.push(...hidden);
    return { hidden: pairsOf(hidden), filtered: pairsOf(filtered.sort((a, b) => a[0] - b[0])) };
}

// Spans in the order of their first line as pairs of a first and a last line, those that meet or touch as one.
function pairsOf(spans: readonly Span[]): number[] {
    const pairs: number[] = [];
    for (const [first, last] of spans) {
        const end = pairs.length - 1;
        if (end > 0 && pairs[end] >= first - 1) pairs[end] = Math.max(pairs[end], last);
        else pairs.push(first, last);
    }
    return pairs;
}

// A sheet's cells as the engine reads them: a rich text is the text of its runs, and only a value, a formula or a
// rich text reaches it.
function sourceOf({ id, fields, cells }: SheetContent): SheetSource {
    return {
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
    };
}

// A cell with a value, a formula or a rich text is the engine's; one with only a link or a mark is not.
function reachesEngine({ v, f, s }: CellRecord): boolean {
    return v !== undefined || f !== undefined || s !== undefined;
}
