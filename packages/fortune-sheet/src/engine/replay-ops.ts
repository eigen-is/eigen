import type { Op, Sheet } from '@workspace/lib/sheets';
import { opToPatchOnSheets } from '@workspace/lib/sheets/yjs-ops';
import { applyPatches, enablePatches } from 'immer';
import { celldataToData, dataToCelldata } from './celldata';
import { applySheetsDeleteRowCol, applySheetsInsertRowCol } from './rowcol';

// immer's patch plugin is a global, idempotent enable. Calling here means any
// consumer of replaySheetsOps gets it transitively without a separate bootstrap.
enablePatches();

type InsertValue = { type: 'row' | 'column'; index: number; count: number; direction: 'lefttop' | 'rightbottom' };
type DeleteValue = { type: 'row' | 'column'; start: number; end: number };

// op.value is intentionally `any` in lib.Op (legacy patch.ts contract). These
// adapters pin the row/col shape so a future RowColOp field addition fails fast
// here rather than silently dropping out of the spread.
function asInsertValue(v: unknown): InsertValue | null {
    if (!v || typeof v !== 'object') return null;
    const { type, index, count, direction } = v as Partial<InsertValue>;
    if (type !== 'row' && type !== 'column') return null;
    if (typeof index !== 'number' || typeof count !== 'number') return null;
    if (direction !== 'lefttop' && direction !== 'rightbottom') return null;
    return { type, index, count, direction };
}

function asDeleteValue(v: unknown): DeleteValue | null {
    if (!v || typeof v !== 'object') return null;
    const { type, start, end } = v as Partial<DeleteValue>;
    if (type !== 'row' && type !== 'column') return null;
    if (typeof start !== 'number' || typeof end !== 'number') return null;
    return { type, start, end };
}

// Snapshots persisted by writeSheetsToYjs / xlsxToSheets carry only `celldata`,
// while ops emitted by fortune-sheet's reducer reference `data[r][c]`. Without
// materializing data first, applyPatches throws "path doesn't resolve" on the
// very first data-targeting op. We materialize on the way in and refresh
// celldata on the way out so consumers (xlsx export, FE state) see a
// consistent shape — but only when ops actually touched `data`. Ops that
// target `celldata` directly are authoritative and we leave them alone.
function withMaterializedData(s: Sheet): Sheet {
    if (s.data) return s;
    const sized = s as { row?: number; column?: number };
    return { ...s, data: celldataToData(s.celldata ?? [], sized.row, sized.column) ?? [] };
}

function withSyncedCelldata(s: Sheet): Sheet {
    return { ...s, celldata: dataToCelldata(s.data) };
}

function batchTouchesData(batch: Op[]): boolean {
    return batch.some((op) => op.path[0] === 'data');
}

export function replaySheetsOps(sheets: Sheet[], opBatches: Op[][]): Sheet[] {
    if (opBatches.length === 0) return sheets;
    // Only materialize/sync when ops actually reference `data[r][c]`. Batches
    // that only target `celldata` paths leave both the input and output shape
    // untouched, so a doc that never opened in the FE round-trips byte-for-byte.
    const sawDataOps = opBatches.some(batchTouchesData);
    let result = sawDataOps ? sheets.map(withMaterializedData) : sheets;
    for (const batch of opBatches) {
        // Special ops first, then convert+apply normal ops against the
        // post-special state. opToPatchOnSheets resolves a sheet id to an
        // index, so it has to run AFTER addSheet/deleteSheet have settled
        // the array — otherwise indices land on wrong (or no longer
        // existing) sheets and applyPatches throws "path doesn't resolve".
        // Mirrors fortune-sheet's applyOp in Workbook/api.ts where special
        // ops drive state changes and patches are best-effort companions.
        for (const op of batch) {
            if (op.op === 'addSheet') {
                result = [...result, op.value as Sheet];
            } else if (op.op === 'deleteSheet' && op.id) {
                result = result.filter((s) => s.id !== op.id);
            } else if (op.op === 'insertRowCol' && op.id) {
                const v = asInsertValue(op.value);
                if (!v) {
                    console.warn('[sheets] insertRowCol op has malformed value', op.value);
                    continue;
                }
                result = applySheetsInsertRowCol(result, { ...v, id: op.id });
            } else if (op.op === 'deleteRowCol' && op.id) {
                const v = asDeleteValue(op.value);
                if (!v) {
                    console.warn('[sheets] deleteRowCol op has malformed value', op.value);
                    continue;
                }
                result = applySheetsDeleteRowCol(result, { ...v, id: op.id });
            }
            // normal ops are handled below in one applyPatches pass
        }
        const normalOps = batch.filter((op) => op.op === 'add' || op.op === 'remove' || op.op === 'replace');
        const [patches] = opToPatchOnSheets(result, normalOps);
        result = applyPatches(result, patches);
    }
    return sawDataOps ? result.map(withSyncedCelldata) : result;
}
