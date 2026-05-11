import type { Op, Sheet } from '@workspace/lib/sheets';
import { opToPatchOnSheets } from '@workspace/lib/sheets/yjs-ops';
import { applyPatches, enablePatches } from 'immer';
import { celldataToData, dataToCelldata } from './celldata';
import { applySheetsDeleteRowCol, applySheetsInsertRowCol, RowColError } from './rowcol';

// immer's patch plugin is a global, idempotent enable. Calling here means any
// consumer of replaySheetsOps gets it transitively without a separate bootstrap.
enablePatches();

type InsertValue = { type: 'row' | 'column'; index: number; count: number; direction: 'lefttop' | 'rightbottom' };
type DeleteValue = { type: 'row' | 'column'; start: number; end: number };

// op.value is `any` in lib.Op; these adapters pin the runtime shape so a
// malformed payload produces a warn+skip rather than corrupt state.
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

function asSheet(v: unknown): Sheet | null {
    if (!v || typeof v !== 'object') return null;
    const sheet = v as Sheet;
    // id is technically optional on Sheet but every patchToOp producer stamps it.
    // A sheet without an id silently breaks subsequent ops referencing that sheet.
    if (typeof sheet.id !== 'string' || typeof sheet.name !== 'string') return null;
    return sheet;
}

// Persisted snapshots carry `celldata` only; ops reference `data[r][c]`. When a
// batch targets `data`, materialize that sheet on the way in and resync its
// `celldata` on the way out. Sheets touched only via `celldata` paths pass
// through unchanged.
function withMaterializedData(s: Sheet): Sheet {
    if (s.data) return s;
    return { ...s, data: celldataToData(s.celldata ?? [], s.row, s.column) };
}

// Sheets reach this path with three possible shapes:
//   - data only (FE flush — state edits update `data` and never refresh `celldata`)
//   - celldata only (xlsx import / fresh doc)
//   - both populated (after replay materialized data, or stale snapshot)
// In every case where data exists, regenerate celldata from it; downstream
// readers (HTML / PDF / XLSX export, preview) are celldata-keyed, so a stale
// celldata field is what causes "exported sheet looks empty" bugs.
function withSyncedCelldataIfData(s: Sheet): Sheet {
    if (!s.data) return s;
    return { ...s, celldata: dataToCelldata(s.data) };
}

// A sheet snapshot persisted as celldata-only must materialize `data` before
// any op that reads/writes through `data[r][c]`. Cell patches reach via
// `path[0] === 'data'`; insertRowCol / deleteRowCol bypass paths and operate
// on `target.data` directly inside the engine — both must trigger materialization.
function collectDataOpSheetIds(opBatches: Op[][]): Set<string> | null {
    let touched: Set<string> | null = null;
    for (const batch of opBatches) {
        for (const op of batch) {
            const needsData =
                (op.path[0] === 'data' && op.id) || ((op.op === 'insertRowCol' || op.op === 'deleteRowCol') && op.id);
            if (needsData && op.id) {
                if (!touched) touched = new Set();
                touched.add(op.id);
            }
        }
    }
    return touched;
}

export function replaySheetsOps(sheets: Sheet[], opBatches: Op[][]): Sheet[] {
    if (opBatches.length === 0) return sheets.map(withSyncedCelldataIfData);
    const dataOpIds = collectDataOpSheetIds(opBatches);
    let result = dataOpIds ? sheets.map((s) => (s.id && dataOpIds.has(s.id) ? withMaterializedData(s) : s)) : sheets;
    for (const batch of opBatches) {
        // Special ops first: opToPatchOnSheets maps sheet id → array index, so
        // addSheet/deleteSheet must settle the array before patches resolve.
        for (const op of batch) {
            if (op.op === 'addSheet') {
                const newSheet = asSheet(op.value);
                if (!newSheet) {
                    console.warn('[sheets] addSheet op has malformed value', op.value);
                    continue;
                }
                result = [...result, newSheet];
            } else if (op.op === 'deleteSheet' && op.id) {
                result = result.filter((s) => s.id !== op.id);
            } else if (op.op === 'insertRowCol' && op.id) {
                const v = asInsertValue(op.value);
                if (!v) {
                    console.warn('[sheets] insertRowCol op has malformed value', op.value);
                    continue;
                }
                // RowColError is a UI-layer signal (readOnly / maxExceeded). On
                // the BE replay path (export, preview, server-side read) there
                // is no user to alert, so skip rather than propagate.
                try {
                    result = applySheetsInsertRowCol(result, { ...v, id: op.id });
                } catch (e) {
                    if (!(e instanceof RowColError)) throw e;
                    console.warn('[sheets] insertRowCol op skipped:', e.code);
                }
            } else if (op.op === 'deleteRowCol' && op.id) {
                const v = asDeleteValue(op.value);
                if (!v) {
                    console.warn('[sheets] deleteRowCol op has malformed value', op.value);
                    continue;
                }
                try {
                    result = applySheetsDeleteRowCol(result, { ...v, id: op.id });
                } catch (e) {
                    if (!(e instanceof RowColError)) throw e;
                    console.warn('[sheets] deleteRowCol op skipped:', e.code);
                }
            }
        }
        const normalOps = batch.filter((op) => op.op === 'add' || op.op === 'remove' || op.op === 'replace');
        const [patches] = opToPatchOnSheets(result, normalOps);
        result = applyPatches(result, patches);
    }
    return result.map(withSyncedCelldataIfData);
}
