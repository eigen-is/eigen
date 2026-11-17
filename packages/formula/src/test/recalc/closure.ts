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
    // It asks the workbook itself, so every marking flags it.
    readonly unnamed: boolean;
    // It works a reference out as it runs, so a marking flags it when no record says what that was.
    readonly resolves: boolean;
    // Sheet, first and last row, first and last column of each area: those its references name, and those a law
    // adds as the ones it resolved.
    readonly areas: number[];
};

// The facts of every shape by its id, which the shape table is given too, as the index reads them there.
export function factsOf(workbook: Workbook): number[] {
    const facts: number[] = [];
    for (let id = 1; id <= workbook.shapes.size; id += 1) {
        const { tree } = workbook.shapes.shape(id);
        facts[id] = tree === null ? 1 << FACT_BITS : shapeFacts(tree, FUNCTIONS);
        workbook.shapes.facts[id] = facts[id];
    }
    return facts;
}

export const cellKey = (sheet: number, column: number, row: number) =>
    (sheet * GRID_COLUMNS + column) * GRID_ROWS + row;

// With `boxed`, a formula that resolves has run, and resolved the box around its first reference and the first
// cell of its second on one sheet, as `=SUM(a:INDEX(b,1,1))` does where both are on the grid.
export function readersOf(workbook: Workbook, facts: readonly number[], boxed: boolean): Reader[] {
    const readers: Reader[] = [];
    const ids = workbook.sheets.map((sheet) => sheet.id);
    workbook.sheets.forEach((sheet, s) => {
        sheet.columns.forEach((cells, column) => {
            for (let row = 0; row < cells.length; row += 1) {
                const id = cells.shape[row];
                if (id === 0 || facts[id] & Fact.Kept) continue;
                const areas: number[] = [];
                const resolves = (facts[id] & Fact.Resolves) !== 0;
                const { refs } = workbook.shapes.shape(id);
                for (const ref of refs) {
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
                if (boxed && resolves && areas.length === 10 && areas[0] === areas[5]) {
                    const [sheet, top, bottom, left, right, , top2, , left2] = areas;
                    areas.push(sheet, Math.min(top, top2), Math.max(bottom, top2));
                    areas.push(Math.min(left, left2), Math.max(right, left2));
                }
                readers.push({
                    sheet: s,
                    column,
                    row,
                    unnamed: (facts[id] & Fact.ReadsUnnamed) !== 0,
                    resolves,
                    areas,
                });
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

// The formulas a marking flags: those that are not pending yet and read a seed span or a formula found here, or
// ask the workbook itself, and with `resolving` those that work a reference out. To be asked before the marking,
// since it reads which are pending.
export function closure(
    workbook: Workbook,
    readers: readonly Reader[],
    seeds: readonly number[],
    resolving: boolean,
): Set<number> {
    const found = new Set<number>();
    const settled = readers.filter(
        ({ sheet, column, row }) => workbook.sheets[sheet].columns[column].kind[row] <= SETTLED,
    );
    const spans = seeds.slice();
    for (const reader of settled) {
        if (!reader.unnamed && !(resolving && reader.resolves)) continue;
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
