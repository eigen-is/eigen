// Replays the stored op batches onto a workbook's stored sheets, for a reader that was not there live, such as a
// browser that opens the workbook or the server's export. It also owns the shape check a sheet or row op passes before
// it applies, and says what a batch's ops can affect, which every reader computes again after the batch. A live
// client's applyOpBatch calls the same checks, so a peer, a joiner and the server skip the same ops and end with the
// same sheets.

import { isRecord } from '@workspace/lib/guards';
import type { Op, Sheet } from '@workspace/lib/sheets';
import { isPatchOp, isStructuralBatch, REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { opToPatchOnSheets, sheetHoldsNoBadLink } from '@workspace/lib/sheets/yjs-ops';
import { enablePatches, Immer } from 'immer';
import { isSheetName, sheetNameKey } from './a1-notation';
import { celldataToData, dataToCelldata } from './celldata';
import { gridSize } from './defaults';
import { FormulaEngine } from './formula-engine';
import { FormulaGraph } from './formula-graph';
import { namesSheet } from './formula-shift';
import type { RecalcBudgets, RecomputeSeeds } from './recalc';
import { recomputeAfter } from './recalc';
import type { DeleteRowColOp, InsertRowColOp } from './rowcol';
import { applySheetsDeleteRowCol, applySheetsInsertRowCol } from './rowcol';
import { normalizeSheetConfig } from './sheet-config';
import type { RenameSheetOp } from './sheet-name';
import { applySheetDelete, applySheetRename } from './sheet-name';
import type { ShiftedSheet } from './types';
import { error } from './validation';

// immer's patch plugin is global, and enabling it twice is harmless. Enabling it here means every caller of
// replaySheetsOps has it without a setup step of its own.
enablePatches();
// The replay copies what it changes and nothing reads its sheets as frozen, and freezing every sheet after each batch
// would cost a long replay a fifth of its time.
const immer = new Immer({ autoFreeze: false });

type InsertValue = Omit<InsertRowColOp, 'id'>;
type DeleteValue = Omit<DeleteRowColOp, 'id'>;

// A batch whose recompute passed a budget. Its ops stand and its formulas keep the values they had, which a reader
// without the budget computes, so such sheets are no state to store.
export class SkippedRecompute extends Error {}

// A batch the replay can't apply is reported to `onDropped`, and so is a recompute past `budgets`, as a
// SkippedRecompute whose batch stands with the values it had. A caller that wants a count of its own passes it. By
// default each one is logged as a warning.
export function replaySheetsOps(
    sheets: Sheet[],
    opBatches: Op[][],
    onDropped: (dropped: unknown) => void = (e) => console.warn('[sheets] replay skipped a batch or its recompute:', e),
    budgets: RecalcBudgets = {},
): Sheet[] {
    // Every base sheet carries its config collections before the first op, so the config patches the editor writes
    // resolve here as they do in the editor.
    let result = sheets.map(withNormalizedSheet);
    // Built at the first batch that recomputes, and kept until a batch renames, adds or deletes a sheet, or a step on
    // it passes a budget, which may leave it short.
    let graph: FormulaGraph | null = null;
    const withinBudget = (step: () => void): RangeError | null => {
        try {
            step();
            return null;
        } catch (e) {
            if (!(e instanceof RangeError)) throw e;
            graph = null;
            return e;
        }
    };
    for (const batch of opBatches) {
        // One bad batch must never make the whole workbook unreadable. It rolls back and the replay goes on with the
        // next batch. The same batch is skipped on every replay.
        const preBatch = result;
        try {
            const dataOpIds = collectDataOpSheetIds(batch);
            if (dataOpIds) {
                result = result.map((s) => (dataOpIds.has(s.id) ? withMaterializedData(s) : s));
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
                    graph = null;
                } else if (op.op === 'deleteSheet' && op.id) {
                    result = applySheetDelete(result, op.id);
                    graph = null;
                } else if (isRowColOp(op)) {
                    const move = rowColOf(op);
                    result = applyRowColOp(result, op);
                    withinBudget(() => graph?.shift(result, move));
                } else if (op.op === 'renameSheet') {
                    result = applySheetRename(result, renameSheetOf(op));
                    graph = null;
                }
            }
            const normalOps = batch.filter(isPatchOp);
            const [patches] = opToPatchOnSheets(result, normalOps);
            result = immer.applyPatches(result, patches);
            if (patches.length > 0) withinBudget(() => graph?.followPatches(result, patches));
            const seeds = seedsOf(batch);
            if (seeds) {
                const materialized = result.map(withMaterializedData);
                result = materialized;
                const engine = new FormulaEngine({ maxCellsRead: budgets.maxCellsRead });
                const passed = withinBudget(() => {
                    graph ??= new FormulaGraph(materialized, budgets);
                    result = recomputeAfter(materialized, seeds, graph, engine);
                });
                if (passed) onDropped(new SkippedRecompute(passed.message, { cause: passed }));
            }
        } catch (e) {
            onDropped(e);
            result = preBatch;
            graph = null;
        }
    }
    return result.map(withSyncedCelldataIfData);
}

// What a batch's sheet, row and column ops can affect, or null when it holds none, since an edit carries its own
// values. A cell its patches write counts too, because an undo's repairs change what the formulas reading them hold.
export function seedsOf(ops: readonly Op[]): RecomputeSeeds | null {
    if (!isStructuralBatch(ops)) return null;
    const cells: RecomputeSeeds['cells'][number][] = [];
    const lines: RecomputeSeeds['lines'][number][] = [];
    const names = new Set<string>();
    // A later row or column op moves the lines an earlier one opened or closed, as it moves the cells on them.
    const moveLines = (id: string, type: 'row' | 'column', at: number, by: number) => {
        for (const [i, seed] of lines.entries()) {
            if (seed.id !== id || seed.type !== type || seed.line < at) continue;
            const line = seed.line + by;
            lines[i] = { ...seed, line: by < 0 ? Math.max(at - 1, line) : line };
        }
    };
    for (const op of ops) {
        const [field, r, c] = op.path;
        if (op.op === 'insertRowCol') {
            const { id, type, index, count, direction } = insertRowColOf(op);
            const line = direction === 'lefttop' ? index : index + 1;
            moveLines(id, type, line, count);
            lines.push({ id, type, line });
        } else if (op.op === 'deleteRowCol') {
            const { id, type, start, end } = deleteRowColOf(op);
            moveLines(id, type, start, start - end - 1);
            lines.push({ id, type, line: start - 1 }, { id, type, line: start });
        } else if (op.op === 'addSheet' || op.op === 'renameSheet') {
            const name = isRecord(op.value) ? op.value['name'] : undefined;
            if (typeof name === 'string') names.add(sheetNameKey(name));
        } else if (isPatchOp(op) && field === 'data' && typeof r === 'number' && typeof c === 'number' && op.id) {
            cells.push({ r, c, id: op.id });
        }
    }
    const reads = (formula: string) =>
        formula.includes(error.r) || [...names].some((name) => namesSheet(formula, name));
    return { cells, lines, reads };
}

// A row or column op's result on plain sheets. An insert past the sheet's size limit throws RowColError.
export function applyRowColOp<S extends ShiftedSheet>(sheets: S[], op: Op): S[] {
    const move = rowColOf(op);
    return 'index' in move ? applySheetsInsertRowCol(sheets, move) : applySheetsDeleteRowCol(sheets, move);
}

function rowColOf(op: Op): InsertRowColOp | DeleteRowColOp {
    return op.op === 'insertRowCol' ? insertRowColOf(op) : deleteRowColOf(op);
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
// sheet-name rule, or a rename's undo could not restore it. Its cells, links and config must read as such on every
// reader.
export function isNewSheet(v: unknown, sheets: { id: string }[]): v is Sheet {
    if (!isRecord(v)) return false;
    const { id, name, data, celldata, config } = v;
    if (data != null && !(Array.isArray(data) && data.every((row) => row == null || Array.isArray(row)))) return false;
    if (celldata != null && !(Array.isArray(celldata) && celldata.every(isRecord))) return false;
    if (config != null && !isRecord(config)) return false;
    if (typeof id !== 'string' || typeof name !== 'string' || !isSheetName(name)) return false;
    return !sheets.some((s) => s.id === id) && sheetHoldsNoBadLink(v);
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
            touched ??= new Set();
            touched.add(op.id);
        }
    }
    return touched;
}

// Where a sheet has the dense matrix, the matrix holds its latest cells: a replayed cell op writes `data` and leaves
// `celldata` stale. The exports and the preview read `celldata`, so it is written again from `data`.
function withSyncedCelldataIfData(s: Sheet): Sheet {
    if (!s.data) return s;
    return { ...s, celldata: dataToCelldata(s.data) };
}
