// The one way to read a workbook: what a cell holds and shows, the look it wears, its lines, merges and records,
// sheet by sheet in tab order. A reader takes a book from `cellsOf` and reads through it, never through the workbook's
// parts. A read hands out what the parts hold, such as the interned look or a stored record, and builds only what it
// returns, so a screen of reads stays cheap.

import type { Literal } from '@workspace/formula';
import { numberDisplay } from '@workspace/formula/format';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type {
    CellAttrs,
    CellContent,
    LineAttrs,
    Records,
    RecordType,
    Rect,
    SheetFields,
    Span,
    ValidationRecord,
} from '@workspace/lib/sheets/ops';
import { cellAt } from './apply-input';
import type { BookSheet, Workbook } from './workbook';

export type Book = {
    readonly sheets: () => readonly Sheet[];
    readonly sheet: (id: string) => Sheet | undefined;
};

// A rectangle of cells that wear one look, every bound inclusive.
type LookArea = {
    readonly c0: number;
    readonly c1: number;
    readonly r0: number;
    readonly r1: number;
    readonly look: Readonly<CellAttrs>;
};

const WHOLE_GRID: Rect = [0, 0, GRID_ROWS - 1, GRID_COLUMNS - 1];

// The workbook as it is now. A book holds no copy, so it reads every later edit too, but its sheets are the ones the
// workbook held when it was made: one deleted since throws at a read, as the engine does, and reads again once added.
export function cellsOf(book: Workbook): Book {
    const sheets = [...book.sheets.keys()].map((id) => new Sheet(id, book));
    const byId = new Map(sheets.map((sheet) => [sheet.id, sheet]));
    return { sheets: () => sheets, sheet: (id) => byId.get(id) };
}

export class Sheet {
    public constructor(
        public readonly id: string,
        private readonly book: Workbook,
    ) {}

    public get fields(): Readonly<SheetFields> {
        return this.parts.records.fields;
    }

    // Read by id at each read, since a batch that deletes a sheet and adds it back gives it new parts.
    private get parts(): BookSheet {
        const parts = this.book.sheets.get(this.id);
        if (!parts) throw new Error(`No sheet ${this.id}`);
        return parts;
    }

    public value(row: number, column: number): Literal | null {
        return this.book.engine.valueOf(this.id, row, column);
    }

    // What an input op would say to put the cell back.
    public content(row: number, column: number): CellContent | null {
        return cellAt(this.book, this.id, this.parts.extras, row, column);
    }

    public hasFormula(row: number, column: number): boolean {
        return this.book.engine.formulaOf(this.id, row, column) !== null;
    }

    public display(row: number, column: number): string {
        return numberDisplay(this.value(row, column), this.look(row, column).fa);
    }

    public look(row: number, column: number): Readonly<CellAttrs> {
        return this.book.looks.look(this.parts.bands.look(row, column));
    }

    // The areas that tile a rectangle, plain ones included, in column order then row order.
    public *lookSpans(rect: Rect): Generator<LookArea> {
        const { looks } = this.book;
        for (const { c0, c1, r0, r1, look } of this.parts.bands.spans(rect)) {
            yield { c0, c1, r0, r1, look: looks.look(look) };
        }
    }

    // The cells that hold a value or a formula, in column order then row order.
    public *values([top, left, bottom, right]: Rect = WHOLE_GRID): Generator<{ r: number; c: number }> {
        const { engine } = this.book;
        const last = Math.min(right, engine.lastColumn(this.id));
        for (let c = left; c <= last; c += 1) {
            for (
                let r = engine.nextCell(this.id, c, top, bottom);
                r >= 0;
                r = engine.nextCell(this.id, c, r + 1, bottom)
            ) {
                yield { r, c };
            }
        }
    }

    // The used range: the styled part joined with the last row and column that hold a value or a formula, -1 for
    // none. A cell that holds only a link or a mark shows nothing, so it is not counted.
    public extent(): { lastRow: number; lastColumn: number } {
        const { engine } = this.book;
        const styled = this.parts.bands.extent();
        return {
            lastRow: Math.max(styled.lastRow, engine.lastRow(this.id)),
            lastColumn: Math.max(styled.lastColumn, engine.lastColumn(this.id)),
        };
    }

    public row(row: number): Readonly<LineAttrs> {
        return this.parts.rows.at(row);
    }

    public column(column: number): Readonly<LineAttrs> {
        return this.parts.columns.at(column);
    }

    // The runs of lines that hold a key, ascending.
    public lines(axis: 'rows' | 'columns'): readonly (readonly [Span, Readonly<LineAttrs>])[] {
        return this.parts[axis].content();
    }

    public merge(row: number, column: number): Rect | undefined {
        return this.parts.records.merge(row, column);
    }

    public touchesMerge(rect: Rect): boolean {
        return this.parts.records.touchesMerge(rect);
    }

    public mergesIn(rect: Rect): readonly Rect[] {
        return this.parts.records.mergesIn(rect);
    }

    public records<T extends Exclude<RecordType, 'sheet'>>(type: T): ReadonlyMap<string, Readonly<Records[T]>> {
        return this.parts.records.records(type);
    }

    public validation(row: number, column: number): Readonly<ValidationRecord> | undefined {
        return this.parts.records.validation(row, column);
    }

    // The ids of the cell's comments, in order.
    public comments(row: number, column: number): readonly string[] {
        return this.parts.records.comments(row, column);
    }
}
