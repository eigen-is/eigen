// The applier of a `record` op, which the frame calls for each op of a batch: one record of a sheet made, changed or
// deleted, such as a merge or a filter, or fields of the sheet itself set, such as its name. The book's record store
// writes it, refusing an id another sheet holds, and hands back the ops that undo it. What the store cannot see is
// checked here first: a new name against the other sheets, and that a sheet stays shown. A new name and tab place go
// to the engine first, as formulas read sheets by both; the inverse of a name that bound formulas renames back, then
// writes them.

import { sheetNameKey } from '@workspace/formula/text';
import { compareRules } from '@workspace/lib/sheets';
import type { InputOp, RecordOp } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { lostInputs } from './apply-input';
import type { Workbook } from './workbook';

export function applyRecord(book: Workbook, op: RecordOp): (RecordOp | InputOp)[] {
    // A peer may have deleted the sheet after the op was written: every reader skips the op alone.
    if (!book.sheets.has(op.sheet)) return [];
    let lost: InputOp[] = [];
    if (op.type === 'sheet') {
        const fields = book.records.fields(op.sheet);
        const { name, order, hide } = op.set;
        const others = [...book.sheets.keys()]
            .filter((id) => id !== op.sheet)
            .map((id) => ({ id, ...book.records.fields(id) }));
        if (hide === 1 && !fields.hide && others.every((other) => other.hide)) throw new Refusal('last-sheet');
        if (name && name !== fields.name) {
            // The engine throws on a name in use, and a peer may have taken it first: the op is skipped alone.
            const key = sheetNameKey(name);
            if (others.some((other) => sheetNameKey(other.name) === key)) return [];
            lost = lostInputs(book, book.engine.renameSheet(op.sheet, name));
        }
        if (order && order !== fields.order) {
            const before = others.filter((other) => compareRules(other.order, other.id, order, op.sheet) < 0);
            book.moveSheet(op.sheet, before.length);
        }
    }
    const inverse = book.records.write(op);
    // The store writes nothing when it refuses: an id in use, a merge onto another, or a chart past its size bound.
    if (typeof inverse === 'string') throw new Refusal(inverse);
    return [...inverse, ...lost];
}
