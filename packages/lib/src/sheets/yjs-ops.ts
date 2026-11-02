// Turns the cell and field ops of a batch into immer patches on a workbook's sheets, for a live tab and the server's
// replay alike. It leaves out the writes no sheet can take, such as an older build's shapes and a peer's malformed
// validation rule, so they fail no batch. It lives in lib so the API can replay ops without the sheet package's state
// barrel, which reaches DOM code.

import type { Patch } from 'immer';
import { isRecord } from '../core/guards';
import { floatingWriteFilter } from './floating';
import type { Op, Sheet } from './types';
import { isSheetValidation, isSheetValidations } from './validations';

// The patches, and the sheet and row ops left for the caller to apply.
export function opToPatchOnSheets(sheets: Sheet[], ops: Op[]): [Patch[], Op[]] {
    const patches: Patch[] = [];
    const specialOps: Op[] = [];
    const applies = floatingWriteFilter(sheets);
    for (const op of ops) {
        const { op: kind } = op;
        if (kind !== 'add' && kind !== 'remove' && kind !== 'replace') {
            specialOps.push(op);
            continue;
        }
        // An op without a sheet id names no sheet, such as the whole `sheets` replace immer emits beside a row op.
        // The row op's own marker carries what changed.
        if (!op.id) continue;
        // An images array, which no per-object write resolves on, is dropped.
        if (op.path.length === 1 && op.path[0] === 'images' && !isRecord(op.value)) continue;
        // The per-cell validation rules of the builds before rules were kept per range are dropped. Nothing reads them,
        // and a write into them fails on a sheet without them, which would roll back the cells of its batch too.
        if (op.path[0] === 'dataVerification') continue;
        if (op.path[0] === 'dataValidations' && !isValidationWrite(op)) continue;
        const i = sheets.findIndex((s) => s.id === op.id);
        if (i === -1) continue;
        const patch: Patch = { op: kind, value: op.value, path: [i, ...op.path] };
        if (applies(patch)) patches.push(patch);
    }
    return [patches, specialOps];
}

// The editor writes a sheet's validations whole or one entry at a time. A write that would leave an entry not well
// formed, or one into an entry's fields, which the editor never sends, is dropped.
function isValidationWrite(op: Op): boolean {
    if (op.path.length === 1) return isSheetValidations(op.value);
    return op.path.length === 2 && (op.op === 'remove' || isSheetValidation(op.value));
}
