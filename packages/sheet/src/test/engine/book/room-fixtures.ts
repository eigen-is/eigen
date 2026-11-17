// Builders for the tests of what a workbook weighs inside a batch: the weight worked out here by walking a book's
// content, without the counts the workbook keeps, sheets that weigh a given amount, and the refusal a run throws.

import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { WorkbookWeight } from '@workspace/lib/sheets/limits';
import { BAND_WEIGHT } from '@workspace/lib/sheets/limits';
import type { CellRecord, FormatOp, Placed, Rect, SheetContent } from '@workspace/lib/sheets/ops';
import { WHOLE_GRID } from '@workspace/lib/sheets/rect';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { Refusal } from '@workspace/lib/sheets/refusal';
import type { Workbook } from '../../../engine/book/workbook';
import type { Book } from './book-fixtures';

export const LAST_ROW = GRID_ROWS - 1;
export const LAST_COLUMN = GRID_COLUMNS - 1;
export const WHOLE: Rect = [0, 0, LAST_ROW, LAST_COLUMN];

export type CellFormat = Extract<FormatOp, { ranges: unknown }>;

export function sheetOf(id: string, part: Partial<SheetContent> = {}): SheetContent {
    const fields = { name: id, order: 'a0' };
    return { id, fields, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

export function bookOf(...sheets: SheetContent[]): Book {
    return { g: 1, now: 45_000, seed: 7, computed: true, sheets };
}

export function format(ranges: Rect[], set?: CellFormat['set'], clear?: CellFormat['clear'], sheet = 'S'): CellFormat {
    return { kind: 'format', sheet, ranges, ...(set && { set }), ...(clear && { clear }) };
}

export function refusalOf(run: () => unknown): RefusalKey | undefined {
    try {
        run();
    } catch (error) {
        if (error instanceof Refusal) return error.key;
        throw error;
    }
    return undefined;
}

// What the limits count of a book, walked from what its parts and its engine list: per column the row after its
// last cell, per band its runs, per entry the units of what it holds.
export function walked(book: Workbook): Omit<WorkbookWeight, 'records' | 'sheets'> {
    const weight = { slots: 0, runs: 0, bands: 0, extras: 0 };
    for (const [id, { bands, extras }] of book.sheets) {
        const flat = bands.content().bands;
        for (let at = 0; at < flat.length; at += 2 + 2 * flat[at + 1]) {
            weight.bands += 1;
            weight.runs += flat[at + 1];
        }
        for (const [, , { s, link, qp }] of extras.cells(WHOLE_GRID)) {
            weight.extras += s || link || qp ? 2 + (link ? 3 : 0) + (s?.length ?? 0) : 0;
        }
        let column = -1;
        let length = 0;
        book.engine.cells(id, (row, at) => {
            if (at !== column) weight.slots += length;
            column = at;
            length = row + 1;
        });
        weight.slots += length;
    }
    return weight;
}

// One band of stripes, each `height` rows of one look then as many of the other, down `stripes` of them.
export function striped(stripes: number, height = 1): Pick<SheetContent, 'looks' | 'bands'> {
    const bands = [0, stripes];
    for (let at = 0; at < stripes; at += 1) bands.push(at * height, 1 + (at % 2));
    return { looks: [{ bl: 1, bg: '#eeeeee' }, { bg: '#eeeeee' }], bands };
}

// Hidden sheets that hold `slots` slots and weigh `formats` in formats, to bring a book to a level: a cell at the
// end of each column, and bands of one run each, no two neighbours alike, the last band with the runs left over.
export function ballast(slots: number, formats: number): SheetContent[] {
    const cells: Placed<CellRecord>[] = [];
    for (let column = 0; column * GRID_ROWS < slots; column += 1) {
        cells.push([Math.min(GRID_ROWS, slots - column * GRID_ROWS) - 1, column, { v: 1 }]);
    }
    const band = 1 + BAND_WEIGHT;
    const sheets: SheetContent[] = [];
    for (let left = formats; left > 0 || sheets.length === 0; ) {
        // The last sheet takes what is left, which is at least a band.
        const last = left < (GRID_COLUMNS + 1) * band;
        const count = last ? Math.min(GRID_COLUMNS, Math.floor(left / band)) : GRID_COLUMNS;
        const over = last ? left - count * band : 0;
        const bands: number[] = [];
        for (let column = 0; column < count - 1; column += 1) bands.push(column, 1, 0, 1 + (column % 2));
        if (count > 0) {
            bands.push(count - 1, 1 + over);
            for (let row = 0; row <= over; row += 1) bands.push(row, 1 + ((count - 1 + row) % 2));
        }
        sheets.push(
            sheetOf(`zz${sheets.length}`, {
                fields: { name: `Ballast ${sheets.length}`, order: 'zz', hide: 1 },
                cells: sheets.length === 0 ? cells : [],
                looks: [{ bl: 1 }, { it: 1 }],
                bands,
            }),
        );
        left -= count * band + over;
        if (count === 0) break;
    }
    return sheets;
}
