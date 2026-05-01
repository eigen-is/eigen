import type { Op, Sheet } from '@workspace/lib/sheets';
import { opToPatchOnSheets } from '@workspace/lib/sheets/yjs-ops';
import { applyPatches, enablePatches } from 'immer';
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

export function replaySheetsOps(sheets: Sheet[], opBatches: Op[][]): Sheet[] {
    if (opBatches.length === 0) return sheets;
    let result = sheets;
    for (const batch of opBatches) {
        const [patches, specialOps] = opToPatchOnSheets(result, batch);
        result = applyPatches(result, patches);
        for (const op of specialOps) {
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
            } else {
                console.warn(`[sheets] unhandled special op: ${op.op}`);
            }
        }
    }
    return result;
}
