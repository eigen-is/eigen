// Pure patch-conversion helper. Lives here (not in fortune-sheet) so the apps/api
// document reader can replay sheet ops without pulling in fortune-sheet's state
// barrel, which transitively reaches into DOM-coupled formula UI code.

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
        if (op.id) {
            const i = sheets.findIndex((s) => s.id === op.id);
            if (i === -1) continue;
            patches.push({
                op: op.op as 'add' | 'remove' | 'replace',
                value: op.value,
                path: [i, ...op.path],
            });
        } else {
            patches.push({
                op: op.op as 'add' | 'remove' | 'replace',
                value: op.value,
                path: op.path,
            });
        }
    }
    return [patches, specialOps];
}
