// The applier of a `record` op: one record of a sheet made, changed or deleted, such as a merge or a filter, or
// fields of the sheet itself set, such as its name. The sheet's record store writes the record and hands back the
// ops that undo the write. What the store cannot see is checked here first: a new name against the other sheets,
// and that a sheet stays shown. A new name and a new place among the tabs go to the engine before anything is
// written, since its formulas read sheets by both. The frame of the appliers calls it for each op of a batch.

import { sheetNameKey } from '@workspace/formula/text';
import { compareRules } from '@workspace/lib/sheets';
import type { RecordOp } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import type { Workbook } from './workbook';

export function applyRecord(book: Workbook, op: RecordOp): RecordOp[] {
    const sheet = book.sheets.get(op.sheet);
    // A peer may have deleted the sheet after the op was written: every reader skips the op alone.
    if (!sheet) return [];
    if (op.type === 'sheet') {
        const { fields } = sheet.records;
        const { name, order, hide } = op.set;
        const others = [...book.sheets]
            .filter(([id]) => id !== op.sheet)
            .map(([id, other]) => ({ id, ...other.records.fields }));
        if (hide === 1 && !fields.hide && others.every((other) => other.hide)) throw new Refusal('last-sheet');
        if (name && name !== fields.name) {
            // The engine throws on a name in use, and a peer may have taken it first: the op is skipped alone.
            const key = sheetNameKey(name);
            if (others.some((other) => sheetNameKey(other.name) === key)) return [];
            book.engine.renameSheet(op.sheet, name);
        }
        if (order && order !== fields.order) {
            const before = others.filter((other) => compareRules(other.order, other.id, order, op.sheet) < 0);
            book.engine.moveSheet(op.sheet, before.length);
        }
    }
    const inverse = sheet.records.write(op);
    if (inverse === 'merge-overlap') throw new Refusal(inverse);
    return inverse;
}
