// The one way a batch of ops changes a workbook, on every host alike, such as the editor's tab, a peer's and the
// server's fold. It applies the ops in order, each through the applier of its kind, and hands back the batch that
// undoes them. A batch lands whole or not at all: when an op is refused, or the workbook is past its limits after
// the last one, the ops that landed are taken back with their own inverses and the refusal is thrown. The ops are
// trusted, since the validators read them at the door.

import { EditRefusal } from '@workspace/formula';
import { fits } from '@workspace/lib/sheets/limits';
import type { Op } from '@workspace/lib/sheets/ops';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyRecord } from './apply-record';
import type { Workbook } from './workbook';

// THE KINDS STILL TO BE BUILT. The unit that builds a kind takes it out of this list and adds its case to
// `applyOne`, which does not compile without it. When the list is empty it goes, and `Applied` is `Op`.
type Unbuilt = 'input' | 'format' | 'lines' | 'move' | 'sheet';
type Applied = Exclude<Op, { kind: Unbuilt }>;

// The key each reason of the engine's refusal is thrown as: a new reason does not compile until it has one.
const REFUSAL_OF = { 'grid-end': 'grid-end', 'too-long': 'key-too-long' } satisfies Record<
    EditRefusal['reason'],
    RefusalKey
>;

// Returns the inverse batch: the inverse ops of every op, the newest op's first, each restoring the state before
// its op. It throws a `Refusal` with the workbook as it was; any other throw leaves the workbook to be reloaded.
export function applyOps(book: Workbook, ops: readonly Applied[]): Applied[] {
    // Each op's inverse ops, in the order the ops landed. They are flattened once, as a spread of a long list passes
    // JavaScript's limit on arguments.
    const landed: Applied[][] = [];
    try {
        for (const op of ops) landed.push(applyOne(book, op));
        const over = fits(book.weight());
        if (over) throw new Refusal(over);
    } catch (error) {
        // The engine refuses an edit before it writes, as an applier does, so the op that threw left nothing.
        const refusal = error instanceof EditRefusal ? new Refusal(REFUSAL_OF[error.reason]) : error;
        if (refusal instanceof Refusal) {
            for (const op of landed.reverse().flat()) applyOne(book, op);
            book.sweepLooks();
        }
        throw refusal;
    }
    // The sweep renumbers the looks, so it runs between batches, when no applier holds a look id.
    book.sweepLooks();
    return landed.reverse().flat();
}

// An applier checks what its op can be refused for and reads what the inverse needs, throwing before its first
// write, then writes, the engine first. It returns the ops that undo its op, in the order they apply.
function applyOne(book: Workbook, op: Applied): Applied[] {
    switch (op.kind) {
        case 'record':
            return applyRecord(book, op);
    }
}
