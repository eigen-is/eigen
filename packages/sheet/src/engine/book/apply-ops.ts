// The one way a batch of ops changes a workbook, on every host alike, such as the editor's tab, a peer's and the
// server's fold. It applies the ops in order, each through the applier of its kind, and hands back the batch that
// undoes them. A batch lands whole or not at all: when an op is refused, or the workbook is past twice a limit after
// an op or past a limit after the last, the ops that landed are taken back with their own inverses, unchecked, and
// the refusal is thrown. The ops are trusted, since the validators read them at the door.

import { EditRefusal } from '@workspace/formula';
import { fits } from '@workspace/lib/sheets/limits';
import type { Op } from '@workspace/lib/sheets/ops';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyFormat } from './apply-format';
import { applyInput } from './apply-input';
import { applyLines } from './apply-lines';
import { applyMove } from './apply-move';
import { applyRecord } from './apply-record';
import { applySheet } from './apply-sheet';
import type { Workbook } from './workbook';

// The key each reason of the engine's refusal is thrown as: a new reason does not compile until it has one.
const REFUSAL_OF = { 'grid-end': 'grid-end', 'too-long': 'key-too-long' } satisfies Record<
    EditRefusal['reason'],
    RefusalKey
>;

// Returns the inverse batch: the inverse ops of every op, the newest op's first, each restoring the state before
// its op. It throws a `Refusal` with the workbook as it was; any other throw leaves the workbook to be reloaded.
export function applyOps(book: Workbook, ops: readonly Op[]): Op[] {
    // Each op's inverse ops, in the order the ops landed. They are flattened once, as a spread of a long list passes
    // JavaScript's limit on arguments.
    const landed: Op[][] = [];
    try {
        for (const op of ops) {
            landed.push(applyOne(book, op, true));
            const midway = book.over();
            if (midway) throw new Refusal(midway);
        }
        const over = fits(book.weight());
        if (over) throw new Refusal(over);
    } catch (error) {
        // The engine refuses an edit before it writes, as an applier does, so the op that threw left nothing.
        const refusal = error instanceof EditRefusal ? new Refusal(REFUSAL_OF[error.reason]) : error;
        if (refusal instanceof Refusal) {
            for (const op of landed.reverse().flat()) applyOne(book, op, false);
            close(book, ops);
        }
        throw refusal;
    }
    close(book, ops);
    return landed.reverse().flat();
}

// What ends a batch, landed or taken back, when no applier holds a look id: the sweep renumbers the looks, and the
// engine is told the rows the sheets hide and filter, which only an input and a format of cells cannot change.
function close(book: Workbook, ops: readonly Op[]): void {
    book.sweepLooks();
    if (ops.some((op) => op.kind !== 'input' && !(op.kind === 'format' && 'ranges' in op))) book.setRowsOut();
}

// An applier checks what its op can be refused for, `checked` also what it can add, and reads what the inverse needs,
// throwing before its first write, then writes, the engine first. It returns the ops that undo its op, in order.
function applyOne(book: Workbook, op: Op, checked: boolean): Op[] {
    switch (op.kind) {
        case 'input':
            return applyInput(book, op, checked);
        case 'format':
            return applyFormat(book, op, checked);
        case 'record':
            return applyRecord(book, op);
        case 'lines':
            return applyLines(book, op, checked);
        case 'move':
            return applyMove(book, op, checked);
        case 'sheet':
            return applySheet(book, op, checked);
    }
}
