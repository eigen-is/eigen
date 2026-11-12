import { FACT_BITS, Fact, shapeFacts } from '../../eval/facts';
import { FUNCTIONS } from '../../functions/library';
import { SETTLED } from '../../store/column';
import type { Workbook } from '../../store/workbook';
import { GRID_COLUMNS, GRID_ROWS } from '../../text/a1';
import { RefFlag, RefKind, SheetKind } from '../../text/tree';

// What marking has to flag, worked out the slow way and from the definition alone: per formula cell the areas it
// reads at its own place, and the formulas a set of written spans reaches by scanning all of them again and again.

export type Reader = {
    readonly sheet: number;
    readonly column: number;
    readonly row: number;
    readonly unnamed: boolean;
    // Sheet, first and last row, first and last column of each area.
    readonly areas: readonly number[];
};

export function factsOf(workbook: Workbook): number[] {
    const facts: number[] = [];
    for (let id = 1; id <= workbook.shapes.size; id += 1) {
        const { tree } = workbook.shapes.shape(id);
        facts[id] = tree === null ? 1 << FACT_BITS : shapeFacts(tree, FUNCTIONS);
    }
    return facts;
}

export const cellKey = (sheet: number, column: number, row: number) =>
    (sheet * GRID_COLUMNS + column) * GRID_ROWS + row;

export function readersOf(workbook: Workbook, facts: readonly number[]): Reader[] {
    const readers: Reader[] = [];
    const ids = workbook.sheets.map((sheet) => sheet.id);
    workbook.sheets.forEach((sheet, s) => {
        sheet.columns.forEach((cells, column) => {
            for (let row = 0; row < cells.length; row += 1) {
                const id = cells.shape[row];
                if (id === 0 || facts[id] & Fact.Kept) continue;
                const areas: number[] = [];
                for (const ref of workbook.shapes.shape(id).refs) {
                    const target =
                        ref.sheetKind === SheetKind.Host
                            ? s
                            : ref.sheetKind === SheetKind.Id
                              ? ids.indexOf(ref.sheet)
                              : -1;
                    if (target < 0) continue;
                    const cell = ref.op === RefKind.Cell;
                    const row1 = ref.flags & RefFlag.RowAbsolute ? ref.row : row + ref.row;
                    const row2 = cell ? row1 : ref.flags & RefFlag.Row2Absolute ? ref.row2 : row + ref.row2;
                    const column1 = ref.flags & RefFlag.ColumnAbsolute ? ref.column : column + ref.column;
                    const column2 = cell
                        ? column1
                        : ref.flags & RefFlag.Column2Absolute
                          ? ref.column2
                          : column + ref.column2;
                    const rows = ref.op === RefKind.Columns ? [0, GRID_ROWS - 1] : [row1, row2];
                    const columns = ref.op === RefKind.Rows ? [0, GRID_COLUMNS - 1] : [column1, column2];
                    const top = Math.min(...rows);
                    const bottom = Math.max(...rows);
                    const left = Math.min(...columns);
                    const right = Math.max(...columns);
                    // A reference that leaves the grid at this cell reads nothing there.
                    if (top < 0 || bottom >= GRID_ROWS || left < 0 || right >= GRID_COLUMNS) continue;
                    areas.push(target, top, bottom, left, right);
                }
                readers.push({ sheet: s, column, row, unnamed: (facts[id] & Fact.ReadsUnnamed) !== 0, areas });
            }
        });
    });
    return readers;
}

export function pendingOf(workbook: Workbook): Set<number> {
    const pending = new Set<number>();
    workbook.sheets.forEach((sheet, s) => {
        sheet.columns.forEach((cells, column) => {
            for (let row = 0; cells.pending > 0 && row < cells.length; row += 1) {
                if (cells.kind[row] > SETTLED) pending.add(cellKey(s, column, row));
            }
        });
    });
    return pending;
}

// The formulas a marking flags: those that are not pending yet and read a seed span, a formula found here, or
// cells they do not name. To be asked before the marking, since it reads which are pending.
export function closure(workbook: Workbook, readers: readonly Reader[], seeds: readonly number[]): Set<number> {
    const found = new Set<number>();
    const settled = readers.filter(
        ({ sheet, column, row }) => workbook.sheets[sheet].columns[column].kind[row] <= SETTLED,
    );
    const spans = seeds.slice();
    for (const reader of settled) {
        if (!reader.unnamed) continue;
        found.add(cellKey(reader.sheet, reader.column, reader.row));
        spans.push(reader.sheet, reader.column, reader.row, reader.row);
    }
    for (let at = 0; at < spans.length; at += 4) {
        for (const reader of settled) {
            const key = cellKey(reader.sheet, reader.column, reader.row);
            if (found.has(key)) continue;
            const { areas } = reader;
            for (let a = 0; a < areas.length; a += 5) {
                if (
                    areas[a] === spans[at] &&
                    areas[a + 1] <= spans[at + 3] &&
                    areas[a + 2] >= spans[at + 2] &&
                    areas[a + 3] <= spans[at + 1] &&
                    areas[a + 4] >= spans[at + 1]
                ) {
                    found.add(key);
                    spans.push(reader.sheet, reader.column, reader.row, reader.row);
                    break;
                }
            }
        }
    }
    return found;
}
