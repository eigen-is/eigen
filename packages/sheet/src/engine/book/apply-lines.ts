// The applier of a `lines` op, which the frame calls for each op of a batch: rows or columns of a sheet inserted or
// deleted. Every part of the workbook follows: the engine's cells and every formula that reads the lines, the looks,
// the line keys, what cells hold beyond a value, and the records of every sheet. An insert that would push anything
// off the grid's end is refused, so its inverse is the delete. The inverse of a delete inserts plain lines and then
// writes back what the deleted lines wore and held, and last the formulas the edit could not keep.

import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { FormatOp, InputOp, LinesOp, RecordOp, Rect, Span } from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { Areas } from './apply-format';
import { inputOfBlocks, lostInputs } from './apply-input';
import type { Workbook } from './workbook';

export function applyLines(book: Workbook, op: LinesOp): (LinesOp | FormatOp | InputOp | RecordOp)[] {
    const part = book.sheets.get(op.sheet);
    // A peer may have deleted the sheet after the op was written: every reader skips the op alone.
    if (!part) return [];
    const { sheet, rows, insert, index, count } = op;
    const { bands, extras } = part;
    const keys = rows ? part.rows : part.columns;
    // The lines an insert pushes off the grid must be empty, or no delete brings them back. The engine refuses the
    // insert for a value or a formula on them, the parts for what they hold.
    if (insert && (bands.wouldPush(op) || keys.wouldPush(op) || extras.wouldPush(op) || part.records.wouldPush(op))) {
        throw new Refusal('grid-end');
    }
    // A rule's formula and a chart's refs on any sheet may read the edited lines.
    const plans = [...book.sheets.values()].map(({ records }) => {
        const plan = records.planLines(op);
        if (plan === 'key-too-long') throw new Refusal(plan);
        return plan;
    });
    const last = index + count - 1;
    const deleted: Rect = rows ? [index, 0, last, GRID_COLUMNS - 1] : [0, index, GRID_ROWS - 1, last];
    // Read before the write, as the engine held it: where the lines stand again once the inverse has inserted them.
    const content = insert ? undefined : inputOfBlocks(book, sheet, [deleted]);

    // The engine refuses with nothing written, here or in a part, and after it nothing refuses.
    const result = book.engine.editLines({ sheet, rows, insert, index, count });
    const worn = new Map<number, Areas>();
    for (const { c0, c1, r0, r1, look } of bands.lines(op)) {
        // The inverse inserts plain lines, so a plain span needs no op.
        if (look === 0) continue;
        let areas = worn.get(look);
        if (!areas) {
            areas = new Areas();
            worn.set(look, areas);
        }
        areas.add(r0, c0, r1, c1);
    }
    const keyed = new Map<string, FormatOp & { spans: Span[] }>();
    for (const [span, attrs] of keys.lines(op)) {
        const held = JSON.stringify(attrs);
        const format = keyed.get(held);
        if (format) format.spans.push(span);
        else keyed.set(held, { kind: 'format', sheet, lines: rows ? 'rows' : 'columns', spans: [span], set: attrs });
    }
    extras.lines(op);
    for (const plan of plans) plan.commit();

    const back: LinesOp = { kind: 'lines', sheet, rows, insert: !insert, index, count };
    const looks = [...worn].map(([id, areas]): FormatOp => {
        const look = book.looks.look(id);
        const clear = LOOK_KEYS.filter((key) => look[key] === undefined);
        return { kind: 'format', sheet, ranges: areas.joined(), set: look, clear };
    });
    return [
        back,
        ...looks,
        ...keyed.values(),
        ...(content ? [content] : []),
        ...plans.flatMap((plan) => plan.restore),
        ...lostInputs(book, result, back),
    ];
}
