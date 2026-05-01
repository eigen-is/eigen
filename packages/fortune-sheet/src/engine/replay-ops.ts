import type { Op, Sheet } from '@workspace/lib/sheets';
import { opToPatchOnSheets } from '@workspace/lib/sheets/yjs-ops';
import { applyPatches, enablePatches } from 'immer';
import { applySheetsRowColOp } from './rowcol';

// immer's patch plugin is a global, idempotent enable. Calling here means any
// consumer of replaySheetsOps gets it transitively without a separate bootstrap.
enablePatches();

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
                result = applySheetsRowColOp(result, { ...op.value, id: op.id, mode: 'insert' });
            } else if (op.op === 'deleteRowCol' && op.id) {
                result = applySheetsRowColOp(result, { ...op.value, id: op.id, mode: 'delete' });
            } else {
                console.warn(`[sheets] unhandled special op: ${op.op}`);
            }
        }
    }
    return result;
}
