// Turns the cell and field ops of a batch into immer patches on a workbook's sheets, for a live tab and the server's
// replay alike. It leaves out the writes no sheet can take, such as a matrix that is no array or a peer's malformed
// validation rule, so they fail no batch. It lives in lib so the API can replay ops without the sheet package's state
// barrel, which reaches DOM code.

import type { Patch } from 'immer';
import { isRecord } from '../core/guards';
import { floatingWriteFilter } from './floating';
import type { Op, Sheet } from './types';
import { isPatchOp } from './types';
import { isSheetValidation, isSheetValidations, MAX_VALIDATIONS } from './validations';

// The patches, and the sheet and row ops left for the caller to apply.
export function opToPatchOnSheets(sheets: Sheet[], ops: Op[]): [Patch[], Op[]] {
    const patches: Patch[] = [];
    const specialOps: Op[] = [];
    const applies = floatingWriteFilter(sheets);
    const ruleIds = validationIds(sheets);
    for (const op of ops) {
        if (!isPatchOp(op)) {
            specialOps.push(op);
            continue;
        }
        // An op without a sheet id names no sheet, such as the whole `sheets` replace immer emits beside a row op.
        // The row op's own marker carries what changed.
        if (!op.id) continue;
        // A log written before a cell's `f` became the one record of its formula holds writes to a list no sheet has.
        if (op.path[0] === 'calcChain') continue;
        // No writer ships a sheet whole or its stored cell list, and a reader with no matrix would be the only one to apply it.
        if (op.path.length === 0 || op.path[0] === 'celldata') continue;
        // Every op finds its sheet by id and a formula by name, so they change only through the checked sheet ops.
        if (op.path[0] === 'id' || op.path[0] === 'name') continue;
        // Every reader walks a sheet's matrix and its rows, so a write that would leave either no array is dropped.
        const writesMatrixOrRow = op.path.length === 1 || (op.path.length === 2 && typeof op.path[1] === 'number');
        if (op.path[0] === 'data' && op.op !== 'remove' && writesMatrixOrRow && !Array.isArray(op.value)) continue;
        if (op.path[0] === 'dataValidations' && !isValidationWrite(op)) continue;
        if (op.path[0] === 'data' && !isCellWrite(op)) continue;
        const i = sheets.findIndex((s) => s.id === op.id);
        if (i === -1) continue;
        if (op.path[0] === 'dataValidations' && !ruleIds(i, op)) continue;
        const patch: Patch = { op: op.op, value: op.value, path: [i, ...op.path] };
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

// A rename and the exports read every link's type and address, so a write that would leave a link without them is
// dropped. The editor writes a link whole, and a cell, a row or a matrix whole with the links it holds.
function isCellWrite({ op, path, value }: Op): boolean {
    if (path[3] === 'link') return path.length === 4 && (op === 'remove' || isLink(value));
    if (op === 'remove' || path.length > 3) return true;
    return Array.isArray(value) ? value.flat().every(holdsNoBadLink) : holdsNoBadLink(value);
}

// A whole sheet a peer adds brings its cells past every cell write, as the matrix or as the stored list.
export function sheetHoldsNoBadLink({ data, celldata }: Record<string, unknown>): boolean {
    if (Array.isArray(data) && !data.flat().every(holdsNoBadLink)) return false;
    return !Array.isArray(celldata) || celldata.every((entry) => !isRecord(entry) || holdsNoBadLink(entry['v']));
}

function holdsNoBadLink(cell: unknown): boolean {
    if (!isRecord(cell)) return true;
    const { link } = cell;
    return link === undefined || isLink(link);
}

function isLink(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const { type, address } = value;
    return typeof type === 'string' && typeof address === 'string';
}

// Says whether a validation write applies. A `replace` means its writer saw the rule, because immer writes `add` for an
// id its base lacked, so where a peer deleted the rule first the delete wins on every tab and in the replay.
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
