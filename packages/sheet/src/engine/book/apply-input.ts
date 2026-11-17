// The applier of an `input` op: what cells of a sheet hold, written over rectangles and then cell by cell, such as
// typing, a paste, a fill or a clear. Values and formulas go to the engine, rich runs, links and the quote mark to the
// sheet's extras; looks and records stay. Its inverse is one `input` that writes back what the targets held, read
// before the write and joined into rectangles of equal content where it can be. The same reading says what blocks
// held, for an edit that takes them, and turns formulas an edit could not keep, such as a rename, back into their text.

import type { EditResult, Literal } from '@workspace/formula';
import type { CellContent, InputOp, LinesOp, Placed, Rect } from '@workspace/lib/sheets/ops';
import { covers } from '@workspace/lib/sheets/rect';
import { Refusal } from '@workspace/lib/sheets/refusal';
import type { Extra, Extras } from './extras';
import { contentOf, literalOf, unitsOf } from './extras';
import { axisOf, spansAfter } from './record-lines';
import { ColumnSweep } from './rect-index';
import type { Workbook } from './workbook';
import { reachesEngine } from './workbook';

// What one cell holds, as read: its value counts beside no formula or beside one whose value is given.
type Held = { value: Literal | null; formula: string | null; given: boolean; extra: Extra | undefined };
// A rectangle of cells that hold equal content, or none, as it grows down a column and then across.
type Group = { top: number; left: number; bottom: number; right: number; held: Held };
// The runs and cells of an input op, as an applier gathers them.
export type Gathered = Required<Omit<InputOp, 'kind' | 'sheet'>>;

const EMPTY: Held = { value: null, formula: null, given: false, extra: undefined };

// `checked`, it throws before a write when the cells it fills would leave the workbook over a limit inside a batch,
// counting nothing it frees.
export function applyInput(book: Workbook, op: InputOp, checked: boolean): InputOp[] {
    const part = book.sheets.get(op.sheet);
    // A peer may have deleted the sheet after the op was written: every reader skips the op alone.
    if (!part) return [];
    const { engine } = book;
    const { sheet } = op;
    const { extras } = part;
    if (checked) {
        let slots = 0;
        const units = filled(op, (column, length) => {
            slots += Math.max(0, length - engine.columnLength(sheet, column));
        });
        const over = book.over({ slots, extras: units });
        if (over) throw new Refusal(over);
    }
    const gathered: Gathered = { runs: [], cells: [] };
    const runs = op.runs ?? [];
    // A run that does not reach the engine empties the cells its read finds there.
    const emptied: Group[] = [];
    const sweep = new ColumnSweep(runs.map(([rect]) => rect));
    readBlocks(book, sheet, extras, sweep, (group, at) => {
        gather(gathered, group, contentOfGroup(group));
        const content = runs[at][1];
        const empties = content === null || !reachesEngine(content);
        if (empties && (group.held.value !== null || group.held.formula !== null)) emptied.push(group);
    });
    // A listed cell inside a run was read with the run. Both come in column order.
    const listed = op.cells ?? [];
    const inRun = new Set<number>();
    let next = 0;
    if (runs.length > 0) {
        sweep.pass((left, right) => {
            for (; next < listed.length && listed[next][1] <= right; next += 1) {
                const at = sweep.after(listed[next][0]) - 1;
                if (listed[next][1] >= left && at >= 0 && sweep.rects[sweep.live[at]][2] >= listed[next][0])
                    inRun.add(next);
            }
        });
    }
    for (const [at, [row, column]] of listed.entries()) {
        if (!inRun.has(at)) gathered.cells.push([row, column, cellAt(book, sheet, extras, row, column)]);
    }

    for (const [rect, content] of runs) {
        const [top, left, bottom, right] = rect;
        const value = content === null ? null : literalOf(content);
        if (content?.f !== undefined) engine.fillFormula(sheet, top, left, bottom, right, content.f, value);
        else if (value !== null) {
            for (let column = left; column <= right; column += 1) {
                for (let row = top; row <= bottom; row += 1) engine.setValue(sheet, row, column, value);
            }
        }
    }
    for (const { top, left, bottom, right } of emptied) {
        for (let column = left; column <= right; column += 1) {
            for (let row = top; row <= bottom; row += 1) engine.clear(sheet, row, column);
        }
    }
    if (runs.length > 0)
        extras.fill(
            sweep,
            runs.map(([, content]) => content ?? {}),
        );
    for (const [row, column, content] of op.cells ?? []) {
        const value = content === null ? null : literalOf(content);
        if (content?.f !== undefined) engine.setFormula(sheet, row, column, content.f, value);
        else if (value === null) engine.clear(sheet, row, column);
        else engine.setValue(sheet, row, column, value);
        extras.write(row, column, content ?? {});
    }
    const back = inputOf(sheet, gathered);
    return back ? [back] : [];
}

// What an input fills: `column` is told once per column the rows it holds once the op's cells that reach the engine
// hold their value, formula or rich text. Returns the units of what the filled cells hold beyond a value.
export function filled(op: InputOp, column: (column: number, length: number) => void): number {
    let units = 0;
    const reach = new Map<number, number>();
    const runs: Rect[] = [];
    for (const [rect, content] of op.runs ?? []) {
        if (!content) continue;
        const [top, left, bottom, right] = rect;
        units += unitsOf(content) * (bottom - top + 1) * (right - left + 1);
        if (reachesEngine(content)) runs.push(rect);
    }
    // Down a column the last run that reaches the engine is the lowest.
    if (runs.length > 0) {
        const sweep = new ColumnSweep(runs);
        sweep.pass((left, right) => {
            const length = runs[sweep.live[sweep.live.length - 1]][2] + 1;
            for (let at = left; at <= right; at += 1) reach.set(at, length);
        });
    }
    for (const [row, at, content] of op.cells ?? []) {
        if (!content) continue;
        units += unitsOf(content);
        if (reachesEngine(content)) reach.set(at, Math.max(reach.get(at) ?? 0, row + 1));
    }
    for (const [at, length] of reach) column(at, length);
    return units;
}

// The input that writes these runs and cells, the cells sorted in column order, or none when there are neither.
export function inputOf(sheet: string, { runs, cells }: Gathered): InputOp | undefined {
    if (runs.length + cells.length === 0) return undefined;
    cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    return { kind: 'input', sheet, ...(runs.length > 0 && { runs }), ...(cells.length > 0 && { cells }) };
}

// What a cell holds now, as an op would say it, null for an empty cell.
export function cellAt(book: Workbook, sheet: string, extras: Extras, row: number, column: number): CellContent | null {
    const { engine } = book;
    const formula = engine.formulaOf(sheet, row, column);
    const given = formula !== null && engine.isGiven(sheet, row, column);
    return contentOf(engine.valueOf(sheet, row, column), formula, given, extras.at(row, column));
}

// What an input writes into a cell: content, null for a cell it empties, or undefined when it does not write the
// cell. A listed cell is written after the rectangles, so its entry is the one that stays.
export function entryAt(op: InputOp, row: number, column: number): CellContent | null | undefined {
    const cells = op.cells ?? [];
    let low = 0;
    let high = cells.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        const [r, c] = cells[middle];
        if (c < column || (c === column && r < row)) low = middle + 1;
        else high = middle;
    }
    if (low < cells.length && cells[low][0] === row && cells[low][1] === column) return cells[low][2];
    return op.runs?.find(([rect]) => covers(rect, row, column))?.[1];
}

// One op per sheet that puts back, with all else the cell holds, the text of each formula an edit could not keep.
// They apply after the edit's own inverse, so with a line edit `after` each cell is said where it stands then.
export function lostInputs(book: Workbook, { rewrites }: EditResult, after?: LinesOp): InputOp[] {
    const bySheet = Map.groupBy(rewrites, ({ sheet }) => sheet);
    const ops: InputOp[] = [];
    // In tab order, as the workbook holds its sheets, not in the order of the engine's rewrites.
    for (const [sheet, { extras }] of book.sheets) {
        const blocks = bySheet.get(sheet);
        if (!blocks) continue;
        const moves = after?.sheet === sheet ? after : undefined;
        const gathered: Gathered = { runs: [], cells: [] };
        const rects: Rect[] = [];
        const texts: string[] = [];
        for (const { top, left, bottom, right, lost } of blocks) {
            if (lost === null) continue;
            rects.push([top, left, bottom, right]);
            texts.push(lost);
        }
        readBlocks(book, sheet, extras, new ColumnSweep(rects), (group, at) => {
            const content = { ...contentOfGroup(group), f: texts[at] };
            for (const placed of moves ? afterLines(moves, group) : [group]) gather(gathered, placed, content);
        });
        const back = inputOf(sheet, gathered);
        if (back) ops.push(back);
    }
    return ops;
}

// What disjoint rectangles of a sheet hold, as the one op that writes it back onto them once they are empty: their
// cells that hold something, read as the inverse of an input reads its runs. None when they hold nothing.
export function inputOfBlocks(book: Workbook, sheet: string, rects: readonly Rect[]): InputOp | undefined {
    const part = book.sheets.get(sheet);
    if (!part) return undefined;
    const gathered: Gathered = { runs: [], cells: [] };
    readBlocks(book, sheet, part.extras, new ColumnSweep(rects), (group) => {
        if (group.held !== EMPTY) gather(gathered, group, contentOfGroup(group));
    });
    return inputOf(sheet, gathered);
}

// Whether two values write the same JSON, a missing one as null.
export function sameJson(a: unknown, b: unknown): boolean {
    return a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// A rectangle where its cells stand after a line edit: in two parts when lines are inserted inside it. A delete here
// undoes an insert, whose rewrites the engine never lays over the empty lines it inserted.
function afterLines(edit: LinesOp, group: Group): Group[] {
    const { rows } = edit;
    const [first, last] = rows ? [group.top, group.bottom] : [group.left, group.right];
    return spansAfter(axisOf(edit), first, last, 'closed').map(([start, end]) =>
        rows ? { ...group, top: start, bottom: end } : { ...group, left: start, right: end },
    );
}

// Reads the blocks a sweep covers and hands over each rectangle of equal content, or of empty cells, of each block with
// its place in the list, once it can grow no further.
function readBlocks(
    book: Workbook,
    sheet: string,
    extras: Extras,
    sweep: ColumnSweep,
    close: (group: Group, at: number) => void,
): void {
    const found: Placed<Held>[][] = sweep.rects.map(() => []);
    const { engine } = book;
    book.cellsIn(sheet, extras, sweep, (row, column, value, formula, extra, at) => {
        const given = formula !== null && engine.isGiven(sheet, row, column);
        found[at].push([row, column, { value, formula, given, extra }]);
    });
    for (const [at, rect] of sweep.rects.entries()) groupBlock(rect, found[at], (group) => close(group, at));
}

// Groups the cells a block holds, in column order, a column at a time. A run of equal content down a column joins the
// rectangle to its left that spans the same rows with the same content.
function groupBlock(
    [top, left, bottom, right]: Rect,
    cells: readonly Placed<Held>[],
    close: (group: Group) => void,
): void {
    // The rectangles that reach the column before, and the runs of this one, both sorted by row.
    let open: Group[] = [];
    let down: Group[] = [];
    let column = left;
    let next = top;
    const gap = (end: number) => {
        if (end >= next) down.push({ top: next, left: column, bottom: end, right: column, held: EMPTY });
    };
    const endColumn = () => {
        gap(bottom);
        const grown: Group[] = [];
        let at = 0;
        for (const group of down) {
            for (; at < open.length && open[at].top < group.top; at += 1) close(open[at]);
            const before = open[at];
            const joins = before?.top === group.top && before.bottom === group.bottom;
            if (joins && sameHeld(before.held, group.held)) {
                before.right = column;
                grown.push(before);
                at += 1;
            } else grown.push(group);
        }
        for (; at < open.length; at += 1) close(open[at]);
        open = grown;
        down = [];
        column += 1;
        next = top;
    };
    // Ends the columns before `at`. From the second empty one on, each joins the one empty rectangle the first left
    // open, so they end at once.
    const reach = (at: number) => {
        for (let ended = 0; ended < 2 && column < at; ended += 1) endColumn();
        if (column < at) {
            open[0].right = at - 1;
            column = at;
        }
    };
    for (const [row, at, held] of cells) {
        reach(at);
        gap(row - 1);
        next = row + 1;
        const last = down.at(-1);
        if (last?.bottom === row - 1 && sameHeld(last.held, held)) last.bottom = row;
        else down.push({ top: row, left: at, bottom: row, right: at, held });
    }
    reach(right + 1);
    for (const group of open) close(group);
}

// Whether two cells read hold the same, compared on what an op would carry.
function sameHeld(a: Held, b: Held): boolean {
    if (a.formula !== b.formula || a.given !== b.given || !sameExtra(a.extra, b.extra)) return false;
    return (a.formula !== null && !a.given) || sameValue(a.value, b.value);
}

// The engine hands out an error a file brought as a new object each time, so errors compare by their text.
function sameValue(a: Literal | null, b: Literal | null): boolean {
    if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) return a.text === b.text;
    return a === b;
}

function sameExtra(a: Extra | undefined, b: Extra | undefined): boolean {
    if (a === undefined || b === undefined) return a === b;
    return a.qp === b.qp && sameJson(a.s, b.s) && sameJson(a.link, b.link);
}

function contentOfGroup({ held }: Group): CellContent | null {
    return contentOf(held.value, held.formula, held.given, held.extra);
}

// A rectangle of one cell goes into the list of cells, which says it in fewer bytes.
function gather({ runs, cells }: Gathered, { top, left, bottom, right }: Group, content: CellContent | null): void {
    if (top === bottom && left === right) cells.push([top, left, content]);
    else runs.push([[top, left, bottom, right], content]);
}
