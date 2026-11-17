// The applier of a `move` op, which the frame calls for each op of a batch: a block of cells moved, as a cut and
// paste or a drag does it, on one sheet or to another. Its content, looks and extras go along, with its comments, the
// merges wholly in it and, on one sheet, the rule ranges wholly in it; formulas and charts that read it follow. What it
// lands on is replaced, comments included. Its inverse moves the block back, then writes back what the cells it landed
// on outside it held, the records the move removed or changed, and the formulas it made lossy.

import type { Move } from '@workspace/formula';
import { BAND_WEIGHT } from '@workspace/lib/sheets/limits';
import type { FormatOp, InputOp, MoveOp, RecordOp, Rect, Span } from '@workspace/lib/sheets/ops';
import { covers, intersect, outsideOf, within } from '@workspace/lib/sheets/rect';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { wornLooks } from './apply-format';
import type { Gathered } from './apply-input';
import { inputOf, inputOfBlocks, lostInputs } from './apply-input';
import type { Workbook } from './workbook';

// `checked`, it throws before a write when the block could leave the workbook over a limit inside a batch where it
// lands: each column grows to the block's last cell, the looks by what a write of each of its bands can add at most.
export function applyMove(book: Workbook, op: MoveOp, checked: boolean): (MoveOp | FormatOp | InputOp | RecordOp)[] {
    const source = book.sheets.get(op.sheet);
    const landing = book.sheets.get(op.toSheet);
    // A peer may have deleted either sheet after the op was written: every reader skips the op alone.
    if (!source || !landing) return [];
    const [top, left, bottom, right] = op.from;
    const rowShift = op.toRow - top;
    const columnShift = op.toColumn - left;
    const oneSheet = op.sheet === op.toSheet;
    if (oneSheet && rowShift === 0 && columnShift === 0) return [];
    const target: Rect = [op.toRow, op.toColumn, bottom + rowShift, right + columnShift];

    // Rule formulas and charts on any sheet may read the block, so the records plan before anything is written.
    const plan = book.records.planMove(op);
    if (typeof plan === 'string') throw new Refusal(plan);
    if (checked) {
        const { engine } = book;
        let slots = 0;
        for (let column = Math.min(right, engine.lastColumn(op.sheet)); column >= left; column -= 1) {
            const last = engine.lastCell(op.sheet, column, bottom, top);
            if (last < 0) continue;
            slots += Math.max(0, last + rowShift + 1 - engine.columnLength(op.toSheet, column + columnShift));
        }
        // The block lands band by band: the first row's spans are its bands.
        const writes = [...source.bands.spans([top, left, top, right])];
        const growth = landing.bands.growth(writes.map(({ c0, c1 }): Span => [c0 + columnShift, c1 + columnShift]));
        // An upper bound: a move with the book at a limit at both ends can be refused though it would fit.
        const formats = growth.runs + growth.bands * BAND_WEIGHT + source.bands.tiles(op.from);
        const over = book.over(slots, formats);
        if (over) throw new Refusal(over);
    }
    // The move back leaves the landed-on cells outside the block plain and empty, so only those are written back.
    const outside = oneSheet ? outsideOf(target, op.from) : [target];
    const held = inputOfBlocks(book, op.toSheet, outside);

    const result = book.engine.moveCells(moveOf(op));
    const covered = landing.bands.move(op, source.bands);
    landing.extras.move(op, source.extras);
    plan.commit();

    const inverse: (MoveOp | FormatOp | InputOp | RecordOp)[] = [
        { kind: 'move', sheet: op.toSheet, from: target, toSheet: op.sheet, toRow: top, toColumn: left },
    ];
    // Each look the landed-on cells wore, put back whole over the cells that wore it.
    const worn: [look: number, rect: Rect][] = [];
    for (const { c0, c1, r0, r1, look } of covered) {
        if (look === 0) continue;
        for (const rect of outside) {
            const both = intersect([r0, c0, r1, c1], rect);
            if (both) worn.push([look, both]);
        }
    }
    inverse.push(...wornLooks(book, op.toSheet, worn));
    if (held) inverse.push(held);
    inverse.push(...plan.restore);
    inverse.push(...movedBack(lostInputs(book, result), op, target));
    return inverse;
}

// The engine's move of the op's block.
export function moveOf({ sheet, from: [top, left, bottom, right], toSheet, toRow, toColumn }: MoveOp): Move {
    const rows = bottom - top + 1;
    return { fromSheet: sheet, row: top, column: left, rows, columns: right - left + 1, toSheet, toRow, toColumn };
}

// The lossy formulas are read where the move left them, and written back after the move back: those in the block go
// back to where it came from, on its own sheet.
function movedBack(ops: readonly InputOp[], op: MoveOp, target: Rect): InputOp[] {
    const rowShift = op.toRow - op.from[0];
    const columnShift = op.toColumn - op.from[1];
    const bySheet = new Map<string, Gathered>();
    const of = (sheet: string) => {
        let gathered = bySheet.get(sheet);
        if (!gathered) {
            gathered = { runs: [], cells: [] };
            bySheet.set(sheet, gathered);
        }
        return gathered;
    };
    for (const { sheet, runs = [], cells = [] } of ops) {
        for (const [rect, content] of runs) {
            const [t, l, b, r] = rect;
            if (sheet !== op.toSheet || !within(rect, target)) of(sheet).runs.push([rect, content]);
            else of(op.sheet).runs.push([[t - rowShift, l - columnShift, b - rowShift, r - columnShift], content]);
        }
        for (const [row, column, content] of cells) {
            if (sheet !== op.toSheet || !covers(target, row, column)) of(sheet).cells.push([row, column, content]);
            else of(op.sheet).cells.push([row - rowShift, column - columnShift, content]);
        }
    }
    return [...bySheet].flatMap(([sheet, gathered]) => inputOf(sheet, gathered) ?? []);
}
