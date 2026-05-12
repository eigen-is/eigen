// Pure patch-conversion helper. Lives here (not in the sheet package) so the apps/api
// document reader can replay sheet ops without pulling in the sheet state barrel,
// which transitively reaches into DOM-coupled formula UI code.

import { partition } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import type { Op, Sheet } from './types';

export function opToPatchOnSheets(sheets: Sheet[], ops: Op[]): [Patch[], Op[]] {
    const [normalOps, specialOps] = partition(
        ops,
        (op) => op.op === 'add' || op.op === 'remove' || op.op === 'replace',
    );
    const patches: Patch[] = [];
    for (const op of normalOps) {
        // Without a sheet id we cannot derive a Sheet[]-rooted path. These ops
        // appear when the sheet reducer reassigns ctx.sheets
        // wholesale (e.g. row/col mutations) — immer emits a synthetic
        // ['sheets'] replace patch as a side effect. The paired
        // insertRowCol/deleteRowCol special op already carries the semantics,
        // so dropping the synthetic patch here is safe; applying it would
        // throw immer error 14 ('only supports array indices') on the array.
        if (!op.id) continue;
        const i = sheets.findIndex((s) => s.id === op.id);
        if (i === -1) continue;
        patches.push({
            op: op.op as 'add' | 'remove' | 'replace',
            value: op.value,
            path: [i, ...op.path],
        });
    }
    return [patches, specialOps];
}
