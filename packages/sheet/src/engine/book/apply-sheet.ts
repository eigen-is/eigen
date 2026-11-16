// The applier of a `sheet` op, which the frame calls for each op of a batch: a sheet added whole, such as a copy, an
// import or the undo of a delete, or a sheet deleted. An add lands as a load of that sheet does, under the first free
// suffix of its name when another sheet has it, so every reader derives the same name; its records bring ids of
// their own. A delete reads the sheet whole first, as its inverse adds it back with its ids; formulas that read the
// sheet keep its id, so the add restores their reads.

import { sheetNameKey } from '@workspace/formula/text';
import type { InputOp, SheetOp } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { MAX_SHEET_NAME_LENGTH } from '@workspace/lib/sheets/sheet-name';
import { lostInputs } from './apply-input';
import type { Workbook } from './workbook';

export function applySheet(book: Workbook, op: SheetOp): (SheetOp | InputOp)[] {
    if ('delete' in op) {
        const sheet = book.sheets.get(op.delete);
        // A peer may have deleted the sheet first: every reader skips the op alone.
        if (!sheet) return [];
        const shown = [...book.sheets].some(([id, other]) => id !== op.delete && !other.records.fields.hide);
        if (!shown) throw new Refusal('last-sheet');
        const add = book.sheetContent(op.delete, sheet);
        book.removeSheet(op.delete);
        return [{ kind: 'sheet', add }];
    }
    const { add } = op;
    // Two peers may add one sheet, as two undos of one delete do: the second is skipped alone.
    if (book.sheets.has(add.id)) return [];
    // An id names one record of its type in the whole book.
    if ([...book.sheets.values()].some(({ records }) => records.sharesId(add.records))) throw new Refusal('id-in-use');
    const taken = new Set([...book.sheets.values()].map(({ records }) => sheetNameKey(records.fields.name)));
    let { name } = add.fields;
    for (let n = 2; taken.has(sheetNameKey(name)); n += 1) {
        const suffix = ` (${n})`;
        name = `${add.fields.name.slice(0, MAX_SHEET_NAME_LENGTH - suffix.length)}${suffix}`;
    }
    const result = book.addSheet({ ...add, fields: { ...add.fields, name } });
    // The delete frees the name first, so the texts it bound stay as typed when they are written back.
    return [{ kind: 'sheet', delete: add.id }, ...lostInputs(book, result)];
}
