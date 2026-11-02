// Pure patch-conversion helper. Lives here (not in the sheet package) so the apps/api
// document reader can replay sheet ops without pulling in the sheet state barrel,
// which transitively reaches into DOM-coupled formula UI code.

import { partition } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { isRecord } from '../core/guards';
import { floatingWriteFilter } from './floating';
import type { Op, Sheet } from './types';
import { isSheetValidation, isSheetValidations } from './validations';

export function opToPatchOnSheets(sheets: Sheet[], ops: Op[]): [Patch[], Op[]] {
    const [normalOps, specialOps] = partition(
        ops,
        (op) => op.op === 'add' || op.op === 'remove' || op.op === 'replace',
    );
    const patches: Patch[] = [];
    const applies = floatingWriteFilter(sheets);
    for (const op of normalOps) {
        // Without a sheet id we cannot derive a Sheet[]-rooted path. These ops
        // appear when the sheet reducer reassigns ctx.sheets
        // wholesale (e.g. row/col mutations) — immer emits a synthetic
        // ['sheets'] replace patch as a side effect. The paired
        // insertRowCol/deleteRowCol special op already carries the semantics,
        // so dropping the synthetic patch here is safe; applying it would
        // throw immer error 14 ('only supports array indices') on the array.
        if (!op.id) continue;
        // An images array, which no per-object write resolves on, is dropped.
        if (op.path.length === 1 && op.path[0] === 'images' && !isRecord(op.value)) continue;
        if (op.path[0] === 'dataValidations' && !isValidationWrite(op)) continue;
        const i = sheets.findIndex((s) => s.id === op.id);
        if (i === -1) continue;
        const patch: Patch = { op: op.op as 'add' | 'remove' | 'replace', value: op.value, path: [i, ...op.path] };
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
