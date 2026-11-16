// The applier of a `move` op, which the frame calls for each op of a batch: a block of cells moved, as a cut and
// paste or a drag does it, on one sheet or to another. Its content, looks and extras go along, with its comments, the
// merges wholly in it and, on one sheet, the rule ranges wholly in it; formulas and charts that read it follow. What it
// lands on is replaced, comments included. Its inverse moves the block back, then writes back what the cells it landed
// on outside it held, the records the move removed or changed, and the formulas it made lossy.

import type { Move } from '@workspace/formula';
import { BAND_WEIGHT } from '@workspace/lib/sheets/limits';
import type { CellContent, FormatOp, InputOp, MoveOp, Placed, RecordOp, Rect, Span } from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import { covers, outsideOf, within } from '@workspace/lib/sheets/rect';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { Areas } from './apply-format';
import { inputOfBlocks, lostInputs } from './apply-input';
import type { Planned } from './records';
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

    // Rule formulas on any sheet may read the block, so every sheet plans before anything is written: the one the
    // block leaves first and the one it lands on next, so every reader refuses with one key.
    const plans: Planned[] = [];
    const planning = new Set([source, landing, ...book.sheets.values()]);
    for (const { records } of planning) {
        const plan = records.planMove(op, source.records);
        if (typeof plan === 'string') throw new Refusal(plan);
        plans.push(plan);
    }
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
        const formats = growth.runs + growth.bands * BAND_WEIGHT + source.bands.tiles(op.from);
        const over = book.over(slots, formats);
        if (over) throw new Refusal(over);
    }
    // The move back leaves the landed-on cells outside the block plain and empty, so only those are written back.
    const outside = oneSheet ? outsideOf(target, op.from) : [target];
    const held = inputOfBlocks(book, op.toSheet, outside);

    const move: Move = {
        fromSheet: op.sheet,
        row: top,
        column: left,
        rows: bottom - top + 1,
        columns: right - left + 1,
        toSheet: op.toSheet,
        toRow: op.toRow,
        toColumn: op.toColumn,
    };
    const result = book.engine.moveCells(move);
    const covered = landing.bands.move(op, source.bands);
    landing.extras.move(op, source.extras);
    for (const plan of plans) plan.commit();

    const inverse: (MoveOp | FormatOp | InputOp | RecordOp)[] = [
        { kind: 'move', sheet: op.toSheet, from: target, toSheet: op.sheet, toRow: top, toColumn: left },
    ];
    // Each look the landed-on cells wore, put back whole over the cells that wore it.
    const looks = new Map<number, Areas>();
    for (const { c0, c1, r0, r1, look } of covered) {
        if (look === 0) continue;
        for (const [t, l, b, r] of outside) {
            const span: Rect = [Math.max(r0, t), Math.max(c0, l), Math.min(r1, b), Math.min(c1, r)];
            if (span[0] > span[2] || span[1] > span[3]) continue;
            let areas = looks.get(look);
            if (!areas) {
                areas = new Areas();
                looks.set(look, areas);
            }
            areas.add(...span);
        }
    }
    for (const [id, areas] of looks) {
        const look = book.looks.look(id);
        const clear = LOOK_KEYS.filter((key) => look[key] === undefined);
        const format: FormatOp = { kind: 'format', sheet: op.toSheet, ranges: areas.joined(), set: { ...look } };
        inverse.push(clear.length > 0 ? { ...format, clear } : format);
    }
    if (held) inverse.push(held);
    for (const plan of plans) inverse.push(...plan.restore);
    inverse.push(...movedBack(lostInputs(book, result), op, target));
    return inverse;
}

// The lossy formulas are read where the move left them, and written back after the move back: those in the block go
// back to where it came from, on its own sheet.
function movedBack(ops: readonly InputOp[], op: MoveOp, target: Rect): InputOp[] {
    const rowShift = op.toRow - op.from[0];
    const columnShift = op.toColumn - op.from[1];
    const bySheet = new Map<string, { runs: [Rect, CellContent | null][]; cells: Placed<CellContent | null>[] }>();
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
    return [...bySheet].map(([sheet, { runs, cells }]) => {
        cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
        return { kind: 'input', sheet, ...(runs.length > 0 && { runs }), ...(cells.length > 0 && { cells }) };
    });
}
