// Applies op batches to a workbook's plain sheets. replaySheetsOps replays the stored log for a reader that was not
// there live, such as a browser that opens the workbook or the server's export, replaySheetsSteps the same replay a
// batch at a time for the server's fold, and the editor applies each batch it takes through the same applySheetsBatch,
// so a peer, a joiner and the server skip the same ops and end with the same sheets. It also owns the shape check a
// sheet or row op passes before it applies, and says what a batch's ops can affect, which every reader computes again.

import { GONE, mapIndex } from '@workspace/formula/text';
import { isRecord } from '@workspace/lib/guards';
import type { Op, Sheet } from '@workspace/lib/sheets';
import {
    isPatchOp,
    isStructuralBatch,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    sheetFitsGrid,
} from '@workspace/lib/sheets';
import { applySheetWrites, opToPatchOnSheets, sheetHoldsNoBadLink } from '@workspace/lib/sheets/yjs-ops';
import { sheetNameKey } from './a1-notation';
import { celldataToData, dataToCelldata } from './celldata';
import { gridSize } from './defaults';
import { FormulaEngine } from './formula-engine';
import { FormulaGraph } from './formula-graph';
import { namesSheet } from './formula-shift';
import type { RecalcBudgets, RecomputeSeeds } from './recalc';
import { recomputeAfter } from './recalc';
import type { DeleteRowColOp, InsertRowColOp } from './rowcol';
import { applySheetsDeleteRowCol, applySheetsInsertRowCol, editOf } from './rowcol';
import { normalizeSheetConfig } from './sheet-config';
import type { RenameSheetOp } from './sheet-name';
import { applySheetDelete, applySheetRename, legalSheetNames } from './sheet-name';
import type { ShiftedSheet } from './types';
import { error } from './validation';

type InsertValue = Omit<InsertRowColOp, 'id'>;
type DeleteValue = Omit<DeleteRowColOp, 'id'>;

// A batch whose recompute passed a budget. Its ops stand and its formulas keep the values they had, which a reader
// without the budget computes, so such sheets are no state to store.
export class SkippedRecompute extends Error {}

// A batch the replay can't apply goes to `onDropped`, and so does a recompute past `budgets` as a SkippedRecompute,
// whose batch stands with the values it had. By default each is logged as a warning.
export function replaySheetsOps(
    sheets: Sheet[],
    opBatches: readonly Op[][],
    onDropped: (dropped: unknown) => void = (e) => console.warn('[sheets] replay skipped a batch or its recompute:', e),
    budgets: RecalcBudgets = {},
): Sheet[] {
    let result: Sheet[] | null = null;
    for (const step of replaySheetsSteps(sheets, opBatches, budgets)) {
        if (step.dropped !== null) onDropped(step.dropped);
        result = step.sheets;
    }
    // An empty log still hands every sheet back with its config collections.
    return (result ?? sheets.map(withNormalizedSheet)).map(withSyncedCelldataIfData);
}

// The replay one batch at a time, which a caller may stop between two, since a batch never changes the sheets it is
// given. A sheet holding the dense matrix has its cells in `data`, not yet written back to `celldata`.
export function* replaySheetsSteps(
    sheets: Sheet[],
    opBatches: readonly Op[][],
    budgets: RecalcBudgets = {},
): Generator<{ sheets: Sheet[]; dropped: unknown }> {
    // Every base sheet carries its config collections before the first op, so the config patches the editor writes
    // resolve here as they do in the editor.
    let result = sheets.map(withNormalizedSheet);
    // Built at the first batch that recomputes, and kept until a batch renames, adds or deletes a sheet, or a step on
    // it passes a budget, which may leave it short.
    let graph: FormulaGraph | null = null;
    for (const batch of opBatches) {
        // One bad batch must never make the whole workbook unreadable. It rolls back and the replay goes on with the
        // next batch. The same batch is skipped on every replay.
        let dropped: unknown = null;
        try {
            const applied = applySheetsBatch(result, batch, graph, budgets);
            result = applied.sheets;
            graph = applied.graph;
            if (applied.skipped) dropped = new SkippedRecompute(applied.skipped.message, { cause: applied.skipped });
        } catch (e) {
            dropped = e;
            graph = null;
        }
        yield { sheets: result, dropped };
    }
}

// A row or column op a batch applied, with the sheets as they were before it.
type AppliedRowColOp = { op: InsertRowColOp | DeleteRowColOp; sheets: Sheet[] };

// One batch on plain sheets, as every reader applies it. A refused sheet, row or column op throws, a write whose
// parent is gone is skipped alone, and a recompute past `budgets` comes back as `skipped`.
export function applySheetsBatch(
    sheets: Sheet[],
    batch: Op[],
    graph: FormulaGraph | null,
    budgets: RecalcBudgets,
): { sheets: Sheet[]; graph: FormulaGraph | null; moved: AppliedRowColOp[]; skipped: RangeError | null } {
    let result = sheets;
    let held = graph;
    const moved: AppliedRowColOp[] = [];
    const withinBudget = (step: () => void): RangeError | null => {
        try {
            step();
            return null;
        } catch (e) {
            if (!(e instanceof RangeError)) throw e;
            held = null;
            return e;
        }
    };
    // A cell or row op writes the dense matrix, a sheet added earlier in the log with only its stored cells included.
    const dataOpIds = new Set(
        batch.flatMap((op) => ((op.path[0] === 'data' || isRowColOp(op)) && op.id ? [op.id] : [])),
    );
    result = result.map((s) => (dataOpIds.has(s.id) ? withMaterializedData(s) : s));
    // A write finds its sheet by its place in the array, so the sheet and row ops settle the array before the writes.
    for (const op of batch) {
        if (op.op === 'addSheet') {
            if (!isNewSheet(op.value, result)) {
                console.warn('[sheets] addSheet op has a malformed value or a taken id', op.value);
                continue;
            }
            const [name] = legalSheetNames(
                [op.value.name],
                result.map((s) => s.name),
            );
            const added = withNormalizedSheet({ ...op.value, name });
            result = [...result, dataOpIds.has(op.value.id) ? withMaterializedData(added) : added];
            held = null;
        } else if (op.op === 'deleteSheet' && op.id) {
            result = applySheetDelete(result, op.id);
            held = null;
        } else if (isRowColOp(op)) {
            const move = rowColOf(op, result);
            if (!move) continue;
            moved.push({ op: move, sheets: result });
            result = applyRowColOp(result, op);
            withinBudget(() => held?.shift(result, move));
        } else if (op.op === 'renameSheet') {
            result = applySheetRename(result, renameSheetOf(op));
            held = null;
        }
    }
    const written = applySheetWrites(result, opToPatchOnSheets(result, batch));
    result = written.sheets;
    if (hidesEverySheet(sheets, result)) throw new Error('A batch may not hide or delete every sheet');
    if (written.applied.length > 0) withinBudget(() => held?.followPatches(result, written.applied));
    const seeds = seedsOf(batch, moved, result);
    let skipped: RangeError | null = null;
    if (seeds) {
        const materialized = result.map(withMaterializedData);
        result = materialized;
        const engine = new FormulaEngine(budgets);
        skipped = withinBudget(() => {
            const built = held ?? new FormulaGraph(materialized, budgets);
            held = built;
            result = recomputeAfter(materialized, seeds, built, engine);
        });
    }
    return { sheets: result, graph: held, moved, skipped };
}

// What a batch's sheet, row and column ops can affect, or null when it holds none, since an edit carries its own
// values. A cell its patches write counts too, because an undo's repairs change what the formulas reading them hold.
function seedsOf(
    ops: readonly Op[],
    moved: readonly AppliedRowColOp[],
    sheets: readonly Sheet[],
): RecomputeSeeds | null {
    if (!isStructuralBatch(ops)) return null;
    const lines: RecomputeSeeds['lines'][number][] = [];
    for (const { op } of moved) {
        const { id, type } = op;
        const edit = editOf(op);
        const at = edit.index;
        // A later op moves the lines an earlier one opened or closed, as it moves the cells on them.
        for (const [i, seed] of lines.entries()) {
            if (seed.id !== id || seed.type !== type) continue;
            const line = mapIndex(edit, seed.line);
            lines[i] = { ...seed, line: line === GONE ? at - 1 : line };
        }
        if ('index' in op) lines.push({ id, type, line: at });
        else lines.push({ id, type, line: at - 1 }, { id, type, line: at });
    }
    const cells: RecomputeSeeds['cells'][number][] = [];
    const names = new Set<string>();
    for (const op of ops) {
        const [field, r, c] = op.path;
        if (op.op === 'addSheet' || op.op === 'renameSheet') {
            // An add whose name was taken landed under another, so the name comes from the sheet, not the op.
            const id = op.op === 'addSheet' && isRecord(op.value) ? op.value['id'] : op.id;
            const name = sheets.find((s) => s.id === id)?.name;
            if (name !== undefined) names.add(sheetNameKey(name));
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
    const move = rowColOf(op, sheets);
    if (!move) return sheets;
    return 'index' in move ? applySheetsInsertRowCol(sheets, move) : applySheetsDeleteRowCol(sheets, move);
}

// The op as it applies, or null for a delete that leaves nothing to take. A delete keeps a sheet's last line: two tabs
// deleting at once can ask for every one, and a stored sheet reads no rows as the default size.
function rowColOf(op: Op, sheets: readonly Sheet[]): InsertRowColOp | DeleteRowColOp | null {
    // An op's value is untyped, so a bad one throws and rolls its batch back, whose other ops were written for the
    // rows it would have moved.
    if (op.op === 'insertRowCol') {
        const value = asInsertValue(op.value);
        if (!value || !op.id) throw new Error('insertRowCol op has a malformed value');
        return { ...value, id: op.id };
    }
    const value = asDeleteValue(op.value);
    if (!value || !op.id) throw new Error('deleteRowCol op has a malformed value');
    const remove = { ...value, id: op.id };
    const data = sheets.find(({ id }) => id === remove.id)?.data;
    const lines = (remove.type === 'row' ? data?.length : data?.[0]?.length) ?? 0;
    if (remove.start > 0 || remove.end < lines - 1) return remove;
    return lines > 1 ? { ...remove, end: lines - 2 } : null;
}

// A stored sheet keeps its cells as the `celldata` list, but a cell op writes `data[r][c]`. So a sheet gets the dense
// matrix before such an op, and the replay writes the list back from it at the end.
export function withMaterializedData(s: Sheet): Sheet {
    if (s.data) return s;
    const { row, column } = gridSize(s);
    return { ...s, data: celldataToData(s.celldata ?? [], row, column) };
}

function renameSheetOf(op: Op): RenameSheetOp {
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

// A new sheet needs an id no sheet has yet, because every later op names its sheet by id. Its name only needs to be
// text: the add repairs and numbers it, so two tabs pressing + at once both keep their sheet under two names.
function isNewSheet(v: unknown, sheets: readonly Sheet[]): v is Sheet {
    if (!isRecord(v)) return false;
    const { id, name, data, celldata, config } = v;
    if (data != null && !(Array.isArray(data) && data.every((row) => row == null || Array.isArray(row)))) return false;
    if (celldata != null && !(Array.isArray(celldata) && celldata.every(isRecord))) return false;
    if (config != null && !isRecord(config)) return false;
    if (typeof id !== 'string' || typeof name !== 'string') return false;
    return !sheets.some((s) => s.id === id) && sheetHoldsNoBadLink(v) && sheetFitsGrid(v);
}

// Whether a step leaves no sheet shown where one was. Two tabs each hiding or deleting one of the last two sheets shown
// would leave the workbook nothing to open on, so every reader refuses such a batch.
export function hidesEverySheet(before: readonly Sheet[], after: readonly Sheet[]): boolean {
    const shown = (sheet: Sheet) => sheet.hide !== 1;
    return before.some(shown) && !after.some(shown);
}

// A row or column op moves the cells after it on its sheet, and it needs the sheet's matrix to apply.
export function isRowColOp(op: Op): boolean {
    return op.op === 'insertRowCol' || op.op === 'deleteRowCol';
}

// The editor writes into `images` and `charts` key by key, and a write into a missing collection is skipped, so every
// sheet enters the replay with them.
function withNormalizedSheet(s: Sheet): Sheet {
    const next = { ...s, config: { ...s.config } };
    normalizeSheetConfig(next);
    return next;
}

// Where a sheet has the dense matrix, the matrix holds its latest cells: a replayed cell op writes `data` and leaves
// `celldata` stale. The exports and the preview read `celldata`, so it is written again from `data`.
function withSyncedCelldataIfData(s: Sheet): Sheet {
    if (!s.data) return s;
    return { ...s, celldata: dataToCelldata(s.data) };
}
