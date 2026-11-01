// Row and column inserts, deletes, hides and unhides on the open workbook. The engine shifts the cells, merges
// and formulas of every sheet (applySheetsInsertRowCol, applySheetsDeleteRowCol); this module writes that result
// back into the editor's draft and shifts what only the editor keeps, such as the filter, read-only rows, the
// calc chain, validation rules, links and the selection. A local edit and a peer's op both come through here.

import { isRecord } from '@workspace/lib/guards';
import type { SingleRange } from '@workspace/lib/sheets';
import { cloneDeep, forEach, isEmpty, size } from 'es-toolkit/compat';
import {
    applySheetsDeleteRowCol,
    applySheetsInsertRowCol,
    shiftCellKeyedForDelete,
    shiftCellKeyedForInsert,
    shiftKeyedMapForDelete,
    shiftKeyedMapForInsert,
    shiftRangeForDelete,
    shiftRangeForInsert,
} from '../../engine/rowcol';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getSheetConfig } from '../context';
import type { FilterEntry, FormulaCell, Sheet } from '../types';
import { getSheetIndex } from '../utils';

type ShiftedFilter = { filterRange: SingleRange | null; filter: Record<string, FilterEntry> | null };

// Writes `frozen` whole, never into it: a peer's unfreeze removes it, and a write inside it would resolve on nothing.
function shiftFrozenFocus(sheet: Sheet, type: 'row' | 'column', shift: (focus: number) => number) {
    const { frozen } = sheet;
    if (!frozen?.range) return;
    const ranged = type === 'row' ? frozen.type === 'rangeRow' : frozen.type === 'rangeColumn';
    if (!ranged && frozen.type !== 'rangeBoth') return;
    const axis = type === 'row' ? 'row_focus' : 'column_focus';
    const focus = shift(frozen.range[axis]);
    if (focus !== frozen.range[axis]) sheet.frozen = { ...frozen, range: { ...frozen.range, [axis]: focus } };
}

function shiftEditorOnlyFieldsForInsert(
    ctx: Context,
    op: { type: 'row' | 'column'; index: number; count: number; direction: 'lefttop' | 'rightbottom'; id: string },
) {
    const { type, index, count, direction } = op;
    const id = op.id || ctx.currentSheetId;
    const sheetIndex = getSheetIndex(ctx, id);
    if (sheetIndex == null) return;
    const sheet = ctx.sheets[sheetIndex];
    if (!sheet) return;

    // calcChain entries are sheet-local; cross-sheet formula text is rewritten by the engine.
    const newCalcChain: FormulaCell[] = [];
    if (sheet.calcChain != null) {
        for (const entry of sheet.calcChain) {
            const calc: FormulaCell = cloneDeep(entry);
            if (type === 'row') {
                if (direction === 'lefttop' && calc.r >= index) calc.r += count;
                else if (direction === 'rightbottom' && calc.r > index) calc.r += count;
            } else {
                if (direction === 'lefttop' && calc.c >= index) calc.c += count;
                else if (direction === 'rightbottom' && calc.c > index) calc.c += count;
            }
            newCalcChain.push(calc);
        }
    }
    sheet.calcChain = newCalcChain;

    const config = sheet.config || {};
    const { filterRange } = sheet;
    const { filter } = sheet;
    let shiftedFilter: ShiftedFilter | null = null;
    if (!isEmpty(filterRange) && filterRange != null) {
        shiftedFilter = { filterRange: null, filter: null };

        let firstRow = filterRange.row[0];
        let lastRow = filterRange.row[1];
        let firstColumn = filterRange.column[0];
        let lastColumn = filterRange.column[1];

        if (type === 'row') {
            if (firstRow < index) {
                if (lastRow === index && direction === 'lefttop') {
                    lastRow += count;
                } else if (lastRow > index) {
                    lastRow += count;
                }
            } else if (firstRow === index) {
                if (direction === 'lefttop') {
                    firstRow += count;
                    lastRow += count;
                } else if (direction === 'rightbottom' && lastRow > index) {
                    lastRow += count;
                }
            } else {
                firstRow += count;
                lastRow += count;
            }

            if (filter != null) {
                const shifted: Record<string, FilterEntry> = {};
                forEach(filter, (_entry, key) => {
                    const hiddenRows = filter[key].rowhidden;
                    const shiftedHiddenRows: Record<string, number> = {};
                    forEach(hiddenRows, (_v1, rowKey) => {
                        const n = parseFloat(rowKey);

                        if (n < index) {
                            shiftedHiddenRows[n] = 0;
                        } else if (n === index) {
                            if (direction === 'lefttop') {
                                shiftedHiddenRows[n + count] = 0;
                            } else if (direction === 'rightbottom') {
                                shiftedHiddenRows[n] = 0;
                            }
                        } else {
                            shiftedHiddenRows[n + count] = 0;
                        }
                    });
                    shifted[key] = cloneDeep(filter[key]);
                    shifted[key].rowhidden = shiftedHiddenRows;
                    shifted[key].str = firstRow;
                    shifted[key].edr = lastRow;
                });
                shiftedFilter.filter = shifted;
            }
        } else if (type === 'column') {
            if (firstColumn < index) {
                if (lastColumn === index && direction === 'lefttop') {
                    lastColumn += count;
                } else if (lastColumn > index) {
                    lastColumn += count;
                }
            } else if (firstColumn === index) {
                if (direction === 'lefttop') {
                    firstColumn += count;
                    lastColumn += count;
                } else if (direction === 'rightbottom' && lastColumn > index) {
                    lastColumn += count;
                }
            } else {
                firstColumn += count;
                lastColumn += count;
            }

            if (filter != null) {
                const shifted: Record<string, FilterEntry> = {};
                forEach(filter, (_entry, key) => {
                    let column = filter[key].cindex;

                    if (column === index && direction === 'lefttop') {
                        column += count;
                    } else if (column > index) {
                        column += count;
                    }

                    shifted[column - firstColumn] = cloneDeep(filter[key]);
                    shifted[column - firstColumn].cindex = column;
                    shifted[column - firstColumn].stc = firstColumn;
                    shifted[column - firstColumn].edc = lastColumn;
                });
                shiftedFilter.filter = shifted;
            }
        }

        shiftedFilter.filterRange = { row: [firstRow, lastRow], column: [firstColumn, lastColumn] };
    }

    if (shiftedFilter != null && shiftedFilter.filter != null) {
        const rowhidden = (config.rowhidden ??= {});
        forEach(shiftedFilter.filter, (entry) => {
            forEach(entry.rowhidden, (_v1, n) => {
                rowhidden[n] = 0;
            });
        });
    }

    if (shiftedFilter != null) {
        sheet.filter = shiftedFilter.filter ?? undefined;
        sheet.filterRange = shiftedFilter.filterRange ?? undefined;
    }

    const normalizedIndex = direction === 'lefttop' ? index - 1 : index;
    shiftFrozenFocus(sheet, type, (focus) => (focus > normalizedIndex ? focus + count : focus));

    // Inserted rows/columns clone the template's validation rules, not its hyperlinks.
    sheet.dataVerification = shiftCellKeyedForInsert(sheet.dataVerification, type, index, count, direction, cloneDeep);
    sheet.hyperlink = shiftCellKeyedForInsert(sheet.hyperlink, type, index, count, direction);
}

function shiftEditorOnlyFieldsForDelete(
    ctx: Context,
    op: { type: 'row' | 'column'; start: number; end: number; id: string },
) {
    const { type, start, end } = op;
    const id = op.id || ctx.currentSheetId;
    const sheetIndex = getSheetIndex(ctx, id);
    if (sheetIndex == null) return;
    const sheet = ctx.sheets[sheetIndex];
    if (!sheet) return;

    const deletedCount = end - start + 1;

    // calcChain entries are sheet-local; entries inside the deleted range drop out.
    const newCalcChain: FormulaCell[] = [];
    if (sheet.calcChain != null) {
        for (const entry of sheet.calcChain) {
            const calc: FormulaCell = cloneDeep(entry);
            if (type === 'row') {
                if (calc.r < start) newCalcChain.push(calc);
                else if (calc.r > end) {
                    calc.r -= deletedCount;
                    newCalcChain.push(calc);
                }
            } else {
                if (calc.c < start) newCalcChain.push(calc);
                else if (calc.c > end) {
                    calc.c -= deletedCount;
                    newCalcChain.push(calc);
                }
            }
        }
    }
    sheet.calcChain = newCalcChain;

    const config = sheet.config || {};
    const { filterRange } = sheet;
    const { filter } = sheet;
    let shiftedFilter: ShiftedFilter | null = null;
    if (!isEmpty(filterRange) && filterRange != null) {
        shiftedFilter = { filterRange: null, filter: null };

        let firstRow = filterRange.row[0];
        let lastRow = filterRange.row[1];
        let firstColumn = filterRange.column[0];
        let lastColumn = filterRange.column[1];

        if (type === 'row') {
            if (firstRow > end) {
                firstRow -= deletedCount;
                lastRow -= deletedCount;

                shiftedFilter.filterRange = {
                    row: [firstRow, lastRow],
                    column: [firstColumn, lastColumn],
                };
            } else if (firstRow < start) {
                if (lastRow < start) {
                } else if (lastRow <= end) {
                    lastRow = start - 1;
                } else {
                    lastRow -= deletedCount;
                }

                shiftedFilter.filterRange = {
                    row: [firstRow, lastRow],
                    column: [firstColumn, lastColumn],
                };
            }

            if (shiftedFilter.filterRange != null && filter != null) {
                const shifted: Record<string, FilterEntry> = {};
                forEach(filter, (_entry, key) => {
                    const hiddenRows = filter[key].rowhidden;
                    const shiftedHiddenRows: Record<string, number> = {};
                    forEach(hiddenRows, (_v1, rowKey) => {
                        const n = parseFloat(rowKey);

                        if (n < start) {
                            shiftedHiddenRows[n] = 0;
                        } else if (n > end) {
                            shiftedHiddenRows[n - deletedCount] = 0;
                        }
                    });

                    if (!isEmpty(shiftedHiddenRows)) {
                        shifted[key] = cloneDeep(filter[key]);
                        shifted[key].rowhidden = shiftedHiddenRows;
                        shifted[key].str = firstRow;
                        shifted[key].edr = lastRow;
                    }
                });
                if (!isEmpty(shifted)) shiftedFilter.filter = shifted;
            }
        } else if (type === 'column') {
            if (firstColumn > end) {
                firstColumn -= deletedCount;
                lastColumn -= deletedCount;

                shiftedFilter.filterRange = {
                    row: [firstRow, lastRow],
                    column: [firstColumn, lastColumn],
                };
            } else if (firstColumn < start) {
                if (lastColumn < start) {
                } else if (lastColumn <= end) {
                    lastColumn = start - 1;
                } else {
                    lastColumn -= deletedCount;
                }

                shiftedFilter.filterRange = {
                    row: [firstRow, lastRow],
                    column: [firstColumn, lastColumn],
                };
            } else {
                if (lastColumn > end) {
                    firstColumn = start;
                    lastColumn -= deletedCount;

                    shiftedFilter.filterRange = {
                        row: [firstRow, lastRow],
                        column: [firstColumn, lastColumn],
                    };
                }
            }

            if (shiftedFilter.filterRange != null && filter != null) {
                const shifted: Record<string, FilterEntry> = {};
                forEach(filter, (_entry, key) => {
                    let column = filter[key].cindex;

                    if (column < start) {
                        shifted[column - firstColumn] = cloneDeep(filter[key]);
                        shifted[column - firstColumn].edc = lastColumn;
                    } else if (column > end) {
                        column -= deletedCount;
                        shifted[column - firstColumn] = cloneDeep(filter[key]);
                        shifted[column - firstColumn].cindex = column;
                        shifted[column - firstColumn].stc = firstColumn;
                        shifted[column - firstColumn].edc = lastColumn;
                    }
                });
                if (!isEmpty(shifted)) shiftedFilter.filter = shifted;
            }
        }
    }

    if (shiftedFilter != null && shiftedFilter.filter != null) {
        const rowhidden = (config.rowhidden ??= {});
        forEach(shiftedFilter.filter, (entry) => {
            forEach(entry.rowhidden, (_v1, n) => {
                rowhidden[n] = 0;
            });
        });
    }

    if (shiftedFilter != null) {
        sheet.filter = shiftedFilter.filter ?? undefined;
        sheet.filterRange = shiftedFilter.filterRange ?? undefined;
    }

    shiftFrozenFocus(sheet, type, (focus) => (focus >= start ? focus - (Math.min(end, focus) - start + 1) : focus));

    sheet.dataVerification = shiftCellKeyedForDelete(sheet.dataVerification, type, start, end);
    sheet.hyperlink = shiftCellKeyedForDelete(sheet.hyperlink, type, start, end);
}

function adjustSelectionForInsert(
    ctx: Context,
    op: { type: 'row' | 'column'; index: number; count: number; direction: 'lefttop' | 'rightbottom'; id: string },
) {
    const { type, index, count, direction } = op;
    const id = op.id || ctx.currentSheetId;
    const sheetIndex = getSheetIndex(ctx, id);
    if (sheetIndex == null) return;
    const sheet = ctx.sheets[sheetIndex];
    if (!sheet) return;
    const { data } = sheet;
    if (!data) return;

    let range = null;
    if (type === 'row') {
        if (direction === 'lefttop') {
            range = [{ row: [index, index + count - 1], column: [0, data[0].length - 1] }];
        } else {
            range = [{ row: [index + 1, index + count], column: [0, data[0].length - 1] }];
        }
    } else {
        if (direction === 'lefttop') {
            range = [{ row: [0, data.length - 1], column: [index, index + count - 1] }];
        } else {
            range = [{ row: [0, data.length - 1], column: [index + 1, index + count] }];
        }
    }

    sheet.selections = range;
    if (sheet.id === ctx.currentSheetId) {
        ctx.selections = range;
    }
}

// Per sheet and per field, never `ctx.sheets = ...` or a whole sheet: a wholesale reassignment makes immer emit one
// replace carrying the whole workbook, shipped over collab on every edit (rowcol-patches.test.ts), and a whole sheet's
// undo would put back its images and charts over a peer's later ones. A moved chart gets only the fields that changed,
// its spec parts, a keyed part an entry at a time, so a peer's move or delete of it, or its edit of another entry, at
// once survives, and the undo puts back only the entries the op moved; an image never moves.
function writeBackSheets(ctx: Context, sheets: Sheet[]) {
    for (const [i, next] of sheets.entries()) {
        const sheet: Record<string, unknown> = ctx.sheets[i];
        for (const [key, value] of Object.entries(next)) {
            if (key !== 'charts' && sheet[key] !== value) sheet[key] = value;
        }
        const { charts } = ctx.sheets[i];
        for (const chart of Object.values(next.charts ?? {})) {
            const stored: Record<string, unknown> | undefined = charts?.[chart.id];
            if (!stored || stored === chart) continue;
            for (const [field, value] of Object.entries(chart)) {
                const record = stored[field];
                if (record === value) continue;
                if (isRecord(record) && isRecord(value)) writeEntries(record, value);
                else stored[field] = value;
            }
        }
    }
}

function writeEntries(record: Record<string, unknown>, next: Record<string, unknown>) {
    for (const [entry, value] of Object.entries(next)) if (record[entry] !== value) record[entry] = value;
    for (const entry of Object.keys(record)) if (!Object.hasOwn(next, entry)) delete record[entry];
}

export function insertRowCol(
    ctx: Context,
    op: {
        type: 'row' | 'column';
        index: number;
        count: number;
        direction: 'lefttop' | 'rightbottom';
        id: string;
    },
    changeSelection = true,
    // A batch through applyOpBatch, such as a peer's op or an undo, applies for a read-only viewer too, and
    // applyOpBatch moves the selection with the cells. The permission guard blocks a viewer's own insert only.
    fromBatch = false,
) {
    if (!fromBatch && ctx.allowEdit === false) return;
    const id = op.id || ctx.currentSheetId;
    if (typeof id !== 'string') return;

    const { type, index, count } = op;

    writeBackSheets(ctx, applySheetsInsertRowCol(ctx.sheets, { ...op, id }));

    const sheetIndex = getSheetIndex(ctx, id);
    if (sheetIndex == null) return;

    const sheet = ctx.sheets[sheetIndex];
    if (!sheet) return;

    // The engine refuses an op on a read-only row or column but does not move them.
    // They shift here, by the same rule as hidden rows and columns.
    const { config } = sheet;
    if (type === 'row' && config?.rowReadOnly) {
        config.rowReadOnly = shiftKeyedMapForInsert(config.rowReadOnly, index, count, op.direction);
    }
    if (type === 'column' && config?.colReadOnly) {
        config.colReadOnly = shiftKeyedMapForInsert(config.colReadOnly, index, count, op.direction);
    }

    sheet.alternateFormatRules = (sheet.alternateFormatRules ?? []).map((rule) => ({
        ...rule,
        cellrange: shiftRangeForInsert(rule.cellrange, op),
    }));

    shiftEditorOnlyFieldsForInsert(ctx, { ...op, id });
    if (changeSelection) adjustSelectionForInsert(ctx, { ...op, id });

    ctx.formulaCache.formulaCellInfoMap = null;
}

export function deleteRowCol(
    ctx: Context,
    op: {
        type: 'row' | 'column';
        start: number;
        end: number;
        id: string;
    },
    // A batch through applyOpBatch, such as a peer's op or an undo, applies for a read-only viewer too, and
    // applyOpBatch moves the selection with the cells. The permission guard blocks a viewer's own delete only.
    fromBatch = false,
) {
    if (!fromBatch && ctx.allowEdit === false) return;
    const id = op.id || ctx.currentSheetId;
    if (typeof id !== 'string') return;

    const { type, start, end } = op;

    writeBackSheets(ctx, applySheetsDeleteRowCol(ctx.sheets, { ...op, id }));

    const sheetIndex = getSheetIndex(ctx, id);
    if (sheetIndex == null) return;

    const sheet = ctx.sheets[sheetIndex];
    if (!sheet) return;

    // The engine refuses an op on a read-only row or column but does not move them.
    // They shift here, by the same rule as hidden rows and columns.
    const { config } = sheet;
    if (type === 'row' && config?.rowReadOnly) {
        config.rowReadOnly = shiftKeyedMapForDelete(config.rowReadOnly, start, end);
    }
    if (type === 'column' && config?.colReadOnly) {
        config.colReadOnly = shiftKeyedMapForDelete(config.colReadOnly, start, end);
    }

    const alternateFormats = [];
    for (const rule of sheet.alternateFormatRules ?? []) {
        const cellrange = shiftRangeForDelete(rule.cellrange, op);
        if (cellrange) alternateFormats.push({ ...rule, cellrange });
    }
    sheet.alternateFormatRules = alternateFormats;

    shiftEditorOnlyFieldsForDelete(ctx, { ...op, id });
    if (!fromBatch) ctx.selections = undefined;

    ctx.formulaCache.formulaCellInfoMap = null;
}

// Hide selected rows/columns
export function hideSelectedRowCol(ctx: Context, type: string) {
    if (!ctx.selections || ctx.selections.length > 1) return 'noMulti';
    const sheet = getSheet(ctx);
    const { data } = sheet;
    // A sheet that is not loaded has nothing to hide.
    if (!data) return '';
    const config = (sheet.config ??= {});
    if (type === 'row') {
        const rowhidden = (config.rowhidden ??= {});
        const [r1, r2] = ctx.selections[0].row;
        const rowhiddenNumber = r2;
        for (let r = r1; r <= r2; r += 1) {
            rowhidden[r] = 0;
        }
        const rowLen = data.length;
        const isEndRow =
            rowLen - 1 === rowhiddenNumber ||
            Object.keys(rowhidden).findIndex((o) => parseInt(o, 10) - 1 === rowhiddenNumber) >= 0;
        if (isEndRow) {
            ctx.selections[0].row[0] -= 1;
            ctx.selections[0].row[1] -= 1;
        } else {
            ctx.selections[0].row[0] += 1;
            ctx.selections[0].row[1] += 1;
        }
    } else if (type === 'column') {
        const colhidden = (config.colhidden ??= {});
        const c1 = ctx.selections[0].column[0];
        const c2 = ctx.selections[0].column[1];
        const colhiddenNumber = c2;
        for (let c = c1; c <= c2; c += 1) {
            colhidden[c] = 0;
        }
        const columnLen = data[0].length;
        const isEndColumn =
            columnLen - 1 === colhiddenNumber ||
            Object.keys(colhidden).findIndex((o) => parseInt(o, 10) - 1 === colhiddenNumber) >= 0;
        if (isEndColumn) {
            ctx.selections[0].column[0] -= 1;
            ctx.selections[0].column[1] -= 1;
        } else {
            ctx.selections[0].column[0] += 1;
            ctx.selections[0].column[1] += 1;
        }
    }
    return '';
}

// Show (unhide) selected rows/columns
export function showSelectedRowCol(ctx: Context, type: string) {
    if (!ctx.selections || ctx.selections.length > 1) return 'noMulti';
    // Unhiding cannot create hidden state, so it must not seed the map: on a sheet with
    // nothing hidden that would ship an op to peers and take an undo entry for a no-op.
    const config = getSheetConfig(ctx);
    if (type === 'row' && config?.rowhidden) {
        const [r1, r2] = ctx.selections[0].row;
        for (let r = r1; r <= r2; r += 1) {
            delete config.rowhidden[r];
        }
    } else if (type === 'column' && config?.colhidden) {
        const [c1, c2] = ctx.selections[0].column;
        for (let c = c1; c <= c2; c += 1) {
            delete config.colhidden[c];
        }
    }
    return '';
}

// Check if the current selection is on a hidden row/column
export function isSelectionOnHiddenRowCol(ctx: Context): boolean {
    const config = getSheetConfig(ctx);
    if (!ctx.selections || (!config?.colhidden && !config?.rowhidden)) return false;
    // If the current selection is on a hidden row/column, it is not editable
    if (config?.colhidden && size(config.colhidden) >= 1) {
        const column = ctx.selections[0]?.column?.[0];
        const isHiddenColumn =
            Object.keys(config.colhidden).findIndex((o) => {
                return column === parseInt(o, 10);
            }) >= 0;
        if (isHiddenColumn) {
            return true;
        }
    }
    if (config?.rowhidden && size(config.rowhidden) >= 1) {
        const row = ctx.selections[0]?.row?.[0];
        const isHiddenRow =
            Object.keys(config.rowhidden).findIndex((o) => {
                return row === parseInt(o, 10);
            }) >= 0;
        if (isHiddenRow) {
            return true;
        }
    }
    return false;
}

// Count hidden rows/columns to skip during keyboard navigation
export function moveCountPastHiddenRowCol(ctx: Context, type: string): number {
    let count = 1;
    if (!ctx.selections) return 0;
    const selection = ctx.selections[0];
    const config = getSheetConfig(ctx);
    const rowhidden = config?.rowhidden ?? {};
    const colhidden = config?.colhidden ?? {};
    if (type === 'ArrowUp' || type === 'ArrowDown') {
        const hiddenRows = Object.keys(rowhidden);
        if (type === 'ArrowUp') {
            let row = selection.row[0] - 1;
            const rowIndex = hiddenRows.indexOf(row.toString());
            for (let i = rowIndex; i >= 0; i -= 1) {
                if (parseInt(hiddenRows[i], 10) === row) {
                    count += 1;
                    row -= 1;
                } else {
                    return count;
                }
            }
        } else {
            let row = selection.row[0] + 1;
            const rowIndex = hiddenRows.indexOf(`${row}`);
            for (let i = rowIndex; i < hiddenRows.length; i += 1) {
                if (parseInt(hiddenRows[i], 10) === row) {
                    count += 1;
                    row += 1;
                } else {
                    return count;
                }
            }
        }
    } else if (type === 'ArrowLeft' || type === 'ArrowRight') {
        const hiddenColumns = Object.keys(colhidden);
        if (type === 'ArrowLeft') {
            let column = selection.column[0] - 1;
            const columnIndex = hiddenColumns.indexOf(column.toString());
            for (let i = columnIndex; i >= 0; i -= 1) {
                if (parseInt(hiddenColumns[i], 10) === column) {
                    count += 1;
                    column -= 1;
                } else {
                    return count;
                }
            }
        } else {
            let column = selection.column[0] + 1;
            const columnIndex = hiddenColumns.indexOf(`${column}`);
            for (let i = columnIndex; i < hiddenColumns.length; i += 1) {
                if (parseInt(hiddenColumns[i], 10) === column) {
                    count += 1;
                    column += 1;
                } else {
                    return count;
                }
            }
        }
    }

    return count;
}
