// Replays the stored op batches onto a workbook's stored sheets, for a reader that was not there live, such as a
// browser that opens the workbook or the server's export. It also owns the shape check a sheet or row op passes before
// it applies. A live client's applyOpBatch calls the same checks, so a peer, a joiner and the server skip the same ops
// and end with the same sheets.

import { isRecord } from '@workspace/lib/guards';
import type { Op, Sheet } from '@workspace/lib/sheets';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { opToPatchOnSheets } from '@workspace/lib/sheets/yjs-ops';
import { applyPatches, enablePatches } from 'immer';
import { isSheetName } from './a1-notation';
import { celldataToData, dataToCelldata } from './celldata';
import { gridSize } from './defaults';
import type { DeleteRowColOp, InsertRowColOp } from './rowcol';
import { applySheetsDeleteRowCol, applySheetsInsertRowCol } from './rowcol';
import { normalizeSheetConfig } from './sheet-config';
import type { RenameSheetOp } from './sheet-name';
import { applySheetRename } from './sheet-name';

// immer's patch plugin is global, and enabling it twice is harmless. Enabling it here means every caller of
// replaySheetsOps has it without a setup step of its own.
enablePatches();

type InsertValue = Omit<InsertRowColOp, 'id'>;
type DeleteValue = Omit<DeleteRowColOp, 'id'>;

// A batch the replay can't apply is reported to `onDropped`, which a caller that wants a count of its own passes. By
// default each one is logged as a warning.
export function replaySheetsOps(
    sheets: Sheet[],
    opBatches: Op[][],
    onDropped: (error: unknown) => void = (e) => console.warn('[sheets] op batch failed to apply, skipping batch:', e),
): Sheet[] {
    // Every base sheet carries its config collections before the first op, so the config patches the editor writes
    // resolve here as they do in the editor.
    let result = sheets.map(withNormalizedSheet);
    for (const batch of opBatches) {
        // One bad batch must never make the whole workbook unreadable. It rolls back and the replay goes on with the
        // next batch. The same batch is skipped on every replay.
        const preBatch = result;
        try {
            const dataOpIds = collectDataOpSheetIds(batch);
            if (dataOpIds) {
                result = result.map((s) => (s.id && dataOpIds.has(s.id) ? withMaterializedData(s) : s));
            }
            // opToPatchOnSheets finds a sheet by its place in the array, so the sheet and row ops settle the array
            // before the patches resolve.
            for (const op of batch) {
                if (op.op === 'addSheet') {
                    if (!isNewSheet(op.value, result)) {
                        console.warn('[sheets] addSheet op has malformed value or a taken id', op.value);
                        continue;
                    }
                    const added = withNormalizedSheet(op.value);
                    result = [...result, dataOpIds?.has(op.value.id) ? withMaterializedData(added) : added];
                } else if (op.op === 'deleteSheet' && op.id) {
                    result = result.filter((s) => s.id !== op.id);
                } else if (op.op === 'insertRowCol') {
                    result = applySheetsInsertRowCol(result, insertRowColOf(op));
                } else if (op.op === 'deleteRowCol') {
                    result = applySheetsDeleteRowCol(result, deleteRowColOf(op));
                } else if (op.op === 'renameSheet') {
                    result = applySheetRename(result, renameSheetOf(op));
                }
            }
            const normalOps = batch.filter((op) => op.op === 'add' || op.op === 'remove' || op.op === 'replace');
            const [patches] = opToPatchOnSheets(result, normalOps);
            result = applyPatches(result, patches);
        } catch (e) {
            onDropped(e);
            result = preBatch;
        }
    }
    return result.map(withSyncedCelldataIfData);
}

// A stored sheet keeps its cells as the `celldata` list, but a cell op writes `data[r][c]`. So a sheet gets the dense
// matrix before such an op, and the replay writes the list back from it at the end.
export function withMaterializedData(s: Sheet): Sheet {
    if (s.data) return s;
    const { row, column } = gridSize(s);
    return { ...s, data: celldataToData(s.celldata ?? [], row, column) };
}

// The insert a row op names. An op's value is untyped and a hostile client may send any shape, so a bad one throws and
// the op's whole batch rolls back, since its other ops were written for the rows the op would have moved.
export function insertRowColOf(op: Op): InsertRowColOp {
    const value = asInsertValue(op.value);
    if (!value || !op.id) throw new Error('insertRowCol op has a malformed value');
    return { ...value, id: op.id };
}

export function deleteRowColOf(op: Op): DeleteRowColOp {
    const value = asDeleteValue(op.value);
    if (!value || !op.id) throw new Error('deleteRowCol op has a malformed value');
    return { ...value, id: op.id };
}

// A rename writes its name into every formula naming the tab, so a long one would run the reader out of memory, which
// applySheetRename refuses.
export function renameSheetOf(op: Op): RenameSheetOp {
    const { name } = isRecord(op.value) ? op.value : { name: undefined };
    if (typeof name !== 'string' || !op.id) throw new Error('renameSheet op has a malformed value');
    return { id: op.id, name };
}

function asInsertValue(v: unknown): InsertValue | null {
    if (!isRecord(v)) return null;
    const { type, index, count, direction } = v;
    if (type !== 'row' && type !== 'column') return null;
    if (!isLine(index, type) || !isLine(count, type) || count < 1) return null;
    if (direction !== 'lefttop' && direction !== 'rightbottom') return null;
    return { type, index, count, direction };
}

function asDeleteValue(v: unknown): DeleteValue | null {
    if (!isRecord(v)) return null;
    const { type, start, end } = v;
    if (type !== 'row' && type !== 'column') return null;
    if (!isLine(start, type) || !isLine(end, type) || start > end) return null;
    return { type, start, end };
}

function isLine(value: unknown, type: 'row' | 'column'): value is number {
    const count = type === 'row' ? REFERENCE_ROW_COUNT : REFERENCE_COLUMN_COUNT;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < count;
}

// A new sheet needs an id no sheet has yet, because every later op names its sheet by id. Its name follows the
// sheet-name rule, or a rename's undo could not restore it.
export function isNewSheet(v: unknown, sheets: { id?: string }[]): v is Sheet & { id: string } {
    if (!isRecord(v)) return false;
    const { id, name } = v;
    return typeof id === 'string' && typeof name === 'string' && isSheetName(name) && !sheets.some((s) => s.id === id);
}

// A row or column op moves the cells after it on its sheet, and it needs the sheet's matrix to apply.
export function isRowColOp(op: Op): boolean {
    return op.op === 'insertRowCol' || op.op === 'deleteRowCol';
}

// The editor writes into `images` and `charts` key by key, and a patch against a missing collection fails and takes
// its whole batch down, so every sheet leaves the replay with them.
function withNormalizedSheet(s: Sheet): Sheet {
    const next = { ...s, config: { ...s.config } };
    normalizeSheetConfig(next);
    return next;
}

// The sheets a batch's cell or row ops touch, which need the dense matrix first. It runs per batch, so a sheet an
// earlier addSheet op brought in with only `celldata` gets its matrix too.
function collectDataOpSheetIds(batch: Op[]): Set<string> | null {
    let touched: Set<string> | null = null;
    for (const op of batch) {
        const needsData = op.path[0] === 'data' || isRowColOp(op);
        if (needsData && op.id) {
            if (!touched) touched = new Set();
            touched.add(op.id);
        }
    }
    return touched;
}

// Where a sheet has the dense matrix, the matrix holds its latest cells: a replayed cell op writes
// `data` and leave `celldata` stale. The exports and the preview read `celldata`, so it is written again from `data`.
function withSyncedCelldataIfData(s: Sheet): Sheet {
    if (!s.data) return s;
    return { ...s, celldata: dataToCelldata(s.data) };
}
