// Turns the cell and field ops of a batch into immer patches on a workbook's sheets, for a live tab and the server's
// replay alike. It leaves out the writes no sheet can take, such as a matrix that is no array or a peer's malformed
// validation rule, so they fail no batch. It lives in lib so the API can replay ops without the sheet package's state
// barrel, which reaches DOM code.

import type { Patch } from 'immer';
import { isRecord } from '../core/guards';
import { floatingWriteFilter } from './floating';
import type { Op, Sheet } from './types';
import { isSheetValidation, isSheetValidations, MAX_VALIDATIONS } from './validations';

// The patches, and the sheet and row ops left for the caller to apply.
export function opToPatchOnSheets(sheets: Sheet[], ops: Op[]): [Patch[], Op[]] {
    const patches: Patch[] = [];
    const specialOps: Op[] = [];
    const applies = floatingWriteFilter(sheets);
    const ruleIds = validationIds(sheets);
    for (const op of ops) {
        const { op: kind } = op;
        if (kind !== 'add' && kind !== 'remove' && kind !== 'replace') {
            specialOps.push(op);
            continue;
        }
        // An op without a sheet id names no sheet, such as the whole `sheets` replace immer emits beside a row op.
        // The row op's own marker carries what changed.
        if (!op.id) continue;
        // A log written before a cell's `f` became the one record of its formula holds writes to a list no sheet has.
        if (op.path[0] === 'calcChain') continue;
        // Every reader walks a sheet's matrix and its rows, so a write that would leave either no array is dropped.
        const writesMatrixOrRow = op.path.length === 1 || (op.path.length === 2 && typeof op.path[1] === 'number');
        if (op.path[0] === 'data' && kind !== 'remove' && writesMatrixOrRow && !Array.isArray(op.value)) continue;
        if (op.path[0] === 'dataValidations' && !isValidationWrite(op)) continue;
        const i = sheets.findIndex((s) => s.id === op.id);
        if (i === -1) continue;
        if (op.path[0] === 'dataValidations' && !ruleIds(i, op)) continue;
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

// Follows the rule ids each sheet holds through a batch, and says whether a validation write applies. A `replace` of
// one rule means its writer saw the rule, because immer writes `add` for an id its base lacked. So where a peer
// deleted the rule first, the replace is dropped and the delete wins, on every tab and in the replay alike. A new rule
// on a sheet that holds MAX_VALIDATIONS is dropped too.
function validationIds(sheets: readonly Sheet[]): (sheet: number, op: Op) => boolean {
    const held = new Map<number, Set<string>>();
    return (sheet, { op, path, value }) => {
        const [, id] = path;
        if (path.length === 1) {
            held.set(sheet, new Set(isRecord(value) ? Object.keys(value) : []));
            return true;
        }
        let ids = held.get(sheet);
        if (!ids) held.set(sheet, (ids = new Set(Object.keys(sheets[sheet].dataValidations ?? {}))));
        const key = String(id);
        if (op === 'replace' && !ids.has(key)) return false;
        if (op === 'add' && !ids.has(key) && ids.size >= MAX_VALIDATIONS) return false;
        if (op === 'remove') ids.delete(key);
        else ids.add(key);
        return true;
    };
}
