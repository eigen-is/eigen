// The state of one spreadsheet document on one host, such as a browser tab or the server: the formula engine, which
// keeps the cells' values and formulas, one table of looks, one store of every sheet's records, and per sheet the bands
// that say which look a cell wears, the keys of its rows and columns and what its cells hold beyond a value. It is
// built from a decoded snapshot and walks back to one, so equal documents give equal snapshots once computed, whatever
// their history. It keeps what the limits weigh as a count, and tells the engine which rows a sheet hides and filters.

import type { EditResult, Literal, SheetSource } from '@workspace/formula';
import { Engine } from '@workspace/formula';
import { GRID_COLUMNS } from '@workspace/formula/text';
import { compareRules } from '@workspace/lib/sheets';
import type { BookContent } from '@workspace/lib/sheets/book-codec';
import type { WorkbookWeight } from '@workspace/lib/sheets/limits';
import { fits, MIDWAY } from '@workspace/lib/sheets/limits';
import type { CellContent, CellRecord, Placed, SheetContent, Span } from '@workspace/lib/sheets/ops';
import { WHOLE_GRID } from '@workspace/lib/sheets/rect';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { Bands } from './bands';
import type { Extra } from './extras';
import { contentOf, Extras, literalOf } from './extras';
import { LineRuns } from './line-runs';
import { LookTable } from './look-table';
import { BookRecords } from './records';
import { ColumnSweep } from './rect-index';

// What one cell holds, as read: its value counts beside no formula or beside one whose value is given.
export type Held = { value: Literal | null; formula: string | null; given: boolean; extra: Extra | undefined };

// The parts of one sheet; its cells are the engine's, its fields and records the record store's. Each part takes an
// op itself, `lines(op)`, `wouldPush(op)` and `move(op, source)`, the last called on the part a block lands on.
export type BookSheet = {
    readonly bands: Bands;
    readonly rows: LineRuns;
    readonly columns: LineRuns;
    readonly extras: Extras;
};

// A look table that holds fewer looks is not swept: the looks no cell wears then cost next to nothing.
const LOOK_SWEEP_FLOOR = 64;

export class Workbook {
    public readonly engine: Engine;
    // A look id is this table's, so it means the same look on every sheet, until the next sweep.
    public readonly looks = new LookTable();
    public readonly records = new BookRecords();
    // In tab order, as the engine holds them, so every reader walks the sheets in one order whatever its history.
    private parts = new Map<string, BookSheet>();
    // The generation: it rises only when the document is replaced whole, never with an edit.
    public readonly g: number;
    // The clock of the last batch that landed, or of the snapshot: its author's time and the seed of its draws.
    private now: number;
    private seed: number;
    // How many looks the table held after its last sweep. The load ends with one, so it counts the looks in use.
    private swept = 0;
    // What the limit on formats counts over every sheet: the bands and the extras add to it wherever they write.
    private readonly held = { runs: 0, bands: 0, extras: 0 };

    // Loads a snapshot, weighing the limits on the bands as rebuilt, the extras as held and the cells as listed
    // before the engine allocates: a document over one throws its refusal. A cell's `spill` mark is dropped, as a
    // band said twice is.
    public constructor({ g, now, seed, computed, sheets }: Readonly<BookContent>) {
        const ordered = sheets.toSorted((a, b) => compareRules(a.fields.order, a.id, b.fields.order, b.id));
        const parts = ordered.map((sheet) => this.partsOf(sheet));
        let slots = 0;
        for (const sheet of ordered) slots += slotsOf(sheet);
        const refusal = fits({ slots, ...this.held, records: this.records.weight(), sheets: parts.length });
        if (refusal) throw new Refusal(refusal);

        // The rows a sheet hides and filters come with its cells, as the values of a computed load were computed
        // with them.
        const sources = ordered.map((sheet, at) => ({ ...sourceOf(sheet), ...this.rowsOut(sheet.id, parts[at]) }));
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
    public sheetContent(id: string, { bands, rows, columns, extras }: BookSheet): SheetContent {
        const cells: Placed<CellRecord>[] = [];
        this.cellsIn(id, extras, new ColumnSweep([WHOLE_GRID]), (row, column, { value, formula, extra }) => {
            const cell = contentOf(value, formula, true, extra);
            if (cell) cells.push([row, column, cell]);
        });
        const look = bands.content();
        return {
            id,
            fields: this.records.fields(id),
            cells,
            looks: look.looks.map((at) => this.looks.look(at)),
            bands: look.bands,
            rows: rows.content(),
            columns: columns.content(),
            records: this.records.content(id),
        };
    }

    // Tells `visit` what each cell the sweep's rectangles cover holds, in column order, with its rectangle's place in
    // the list: the engine's cells joined with the extras, a cell with only a link or a mark among them.
    public cellsIn(
        sheet: string,
        extras: Extras,
        sweep: ColumnSweep,
        visit: (...cell: [...Placed<Held>, number]) => void,
    ): void {
        const { rects, live } = sweep;
        if (rects.length === 0) return;
        const { engine } = this;
        const marks: [row: number, column: number, extra: Extra, at: number][] = [];
        extras.within(sweep, (...mark) => marks.push(mark));
        let mark = 0;
        // The rectangle the engine reads now.
        let block = 0;
        const before = (row: number, column: number) => {
            for (; mark < marks.length; mark += 1) {
                const [r, c, extra, at] = marks[mark];
                if (c > column || (c === column && r >= row)) break;
                visit(r, c, { value: null, formula: null, given: false, extra }, at);
            }
        };
        const cell = (row: number, column: number, value: Literal | null, formula: string | null) => {
            before(row, column);
            const here = marks[mark]?.[0] === row && marks[mark][1] === column;
            const given = formula !== null && engine.isGiven(sheet, row, column);
            visit(row, column, { value, formula, given, extra: here ? marks[mark][2] : undefined }, block);
            if (here) mark += 1;
        };
        const lastColumn = engine.lastColumn(sheet);
        sweep.pass((left, right) => {
            for (let column = left; column <= Math.min(right, lastColumn); column += 1) {
                // The rectangles that start past the column's last cell hold nothing of the engine's.
                const end = sweep.after(engine.columnLength(sheet, column) - 1);
                for (let at = 0; at < end; at += 1) {
                    block = live[at];
                    const [top, , bottom] = rects[block];
                    engine.cells(sheet, cell, top, column, bottom, column);
                }
            }
        });
        before(0, GRID_COLUMNS);
    }

    // Adds a sheet as the load builds one, in its place among the tabs, and hands back the formulas its name bound.
    // `checked`, its parts and cells are weighed before the engine takes it; a refusal, the engine's too, leaves none.
    public addSheet(sheet: SheetContent, checked: boolean): EditResult {
        let place = 0;
        for (const id of this.parts.keys()) {
            if (compareRules(this.records.fields(id).order, id, sheet.fields.order, sheet.id) < 0) place += 1;
        }
        const part = this.partsOf(sheet);
        try {
            const over = checked ? this.over(slotsOf(sheet)) : null;
            if (over) throw new Refusal(over);
            const result = this.engine.addSheet(sourceOf(sheet), place);
            this.place(sheet.id, part, place);
            return result;
        } catch (error) {
            this.forget(sheet.id, part);
            throw error;
        }
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
        const part = this.parts.get(id);
        if (part) this.forget(id, part);
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
            const { hidden, filtered } = this.rowsOut(id, part);
            this.engine.setRowsOut(id, hidden, filtered);
        }
    }

    // What the limits count: the engine's slots, the runs, bands and extras of every sheet, its records, the sheets.
    public weight(): WorkbookWeight {
        return { slots: this.engine.slots(), ...this.held, records: this.records.weight(), sheets: this.parts.size };
    }

    // The limit the workbook would be over inside a batch, where each holds `MIDWAY` times, with this many slots
    // and this much weight of formats more, or null. Records are weighed at the end of a batch only.
    public over(slots = 0, formats = 0): RefusalKey | null {
        const { runs, bands, extras } = this.held;
        const sheets = this.parts.size;
        const weight = { slots: this.engine.slots() + slots, runs: runs + formats, bands, extras, records: 0, sheets };
        return fits(weight, MIDWAY);
    }

    // Forgets the looks no cell wears once the table holds twice the looks its last sweep left, renumbering the rest in
    // every sheet's bands: an applier calls it once a batch is done, with no look id in hand.
    public sweepLooks(): void {
        if (this.looks.size > Math.max(LOOK_SWEEP_FLOOR, 2 * this.swept)) this.sweep();
    }

    // A sheet's parts, its looks interned into the table and its bands rebuilt in the one form whatever it said.
    private partsOf({ id, fields, cells, looks, bands, rows, columns, records }: SheetContent): BookSheet {
        const extras = new Extras(this.held);
        for (const [row, column, { s, link, qp }] of cells) {
            if (s || link || qp) extras.write(row, column, { s, link, qp });
        }
        this.records.add(id, fields, records);
        return {
            bands: new Bands(
                bands,
                looks.map((look) => this.looks.intern(look)),
                this.held,
            ),
            rows: new LineRuns(rows),
            columns: new LineRuns(columns),
            extras,
        };
    }

    // Takes the sheet's records and what its parts weigh out of the book: it leaves the workbook, or never entered it.
    private forget(id: string, { bands, extras }: BookSheet): void {
        this.records.remove(id);
        const looks = bands.weight();
        this.held.runs -= looks.runs;
        this.held.bands -= looks.bands;
        this.held.extras -= extras.weight();
    }

    // The rows SUBTOTAL and AGGREGATE leave out, as the engine takes them: those a person hid and those the columns of
    // the sheet's filter left out. While the filter leaves a row out, Excel counts every hidden row of the sheet as
    // filtered, inside its range or not. A hidden column matters to neither function.
    private rowsOut(sheet: string, { rows }: BookSheet): { hidden: number[]; filtered: number[] } {
        const hidden = rows.content().flatMap(([span, attrs]) => (attrs.hidden ? [span] : []));
        const filters = this.records.records(sheet, 'filter');
        const filtered = [...this.records.records(sheet, 'filterColumn').values()].flatMap((column) =>
            filters.has(column.filter) ? column.rows : [],
        );
        if (filtered.length > 0) filtered.push(...hidden);
        return { hidden: pairsOf(hidden), filtered: pairsOf(filtered.sort((a, b) => a[0] - b[0])) };
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
            bands.write([WHOLE_GRID], (id) => moved[id]);
        }
        this.swept = this.looks.size;
    }
}

// The slots the engine gives a sheet's cells: they come in column order, so a column's last cell says its length.
function slotsOf({ cells }: SheetContent): number {
    let slots = 0;
    let column = -1;
    let length = 0;
    for (const [row, at, cell] of cells) {
        if (!reachesEngine(cell)) continue;
        if (at !== column) slots += length;
        column = at;
        length = row + 1;
    }
    return slots + length;
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

// A sheet's cells as the engine reads them: only a value, a formula or a rich text reaches it.
function sourceOf({ id, fields, cells }: SheetContent): SheetSource {
    return {
        id,
        name: fields.name,
        cells: (cell) => {
            for (const [row, column, record] of cells) {
                if (reachesEngine(record)) cell(row, column, literalOf(record), record.f ?? null);
            }
        },
    };
}

// A cell with a value, a formula or a rich text is the engine's; one with only a link or a mark is not.
export function reachesEngine({ v, f, s }: CellContent): boolean {
    return v !== undefined || f !== undefined || s !== undefined;
}
