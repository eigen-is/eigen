// The applier of an `input` op: what cells of a sheet hold, written over rectangles and then cell by cell, such as
// typing, a paste, a fill or a clear. Values and formulas go to the engine, rich runs, links and the quote mark to the
// sheet's extras; looks and records stay. Its inverse is one `input` that writes back what the targets held, read
// before the write as the engine and the extras hold it, joined into rectangles of equal content where it can be.
// The same reading turns the formulas an edit bound, such as a rename, back into the text they held.

import type { EditResult, Literal } from '@workspace/formula';
import { errorOf } from '@workspace/formula';
import type { CellContent, InputOp, Placed, Rect } from '@workspace/lib/sheets/ops';
import type { Extra, Extras } from './extras';
import { contentOf, textOf } from './extras';
import type { Workbook } from './workbook';

// What one cell holds, as read: its value counts beside no formula or beside one whose value is given.
type Held = { value: Literal | null; formula: string | null; given: boolean; extra: Extra | undefined };
// A rectangle of cells that hold equal content, or none, as it grows down a column and then across.
type Group = { top: number; left: number; bottom: number; right: number; held: Held };
type Gathered = { runs: [Rect, CellContent | null][]; cells: Placed<CellContent | null>[] };

const EMPTY: Held = { value: null, formula: null, given: false, extra: undefined };

export function applyInput(book: Workbook, op: InputOp): InputOp[] {
    const part = book.sheets.get(op.sheet);
    // A peer may have deleted the sheet after the op was written: every reader skips the op alone.
    if (!part) return [];
    const { engine } = book;
    const { sheet } = op;
    const { extras } = part;
    const gathered: Gathered = { runs: [], cells: [] };
    for (const [rect] of op.runs ?? []) {
        readBlock(book, sheet, extras, rect, (group) => gather(gathered, group, contentOfGroup(group)));
    }
    for (const [row, column] of op.cells ?? []) {
        const formula = engine.formulaOf(sheet, row, column);
        const given = formula !== null && engine.isGiven(sheet, row, column);
        const content = contentOf(engine.valueOf(sheet, row, column), formula, given, extras.at(row, column));
        gathered.cells.push([row, column, content]);
    }

    for (const [rect, content] of op.runs ?? []) {
        const [top, left, bottom, right] = rect;
        const value = content === null ? null : literalOf(content);
        if (content?.f !== undefined) engine.fillFormula(sheet, top, left, bottom, right, content.f, value);
        else if (value === null) {
            for (let column = left; column <= right; column += 1) {
                for (let row = engine.nextCell(sheet, column, top, bottom); row >= 0; ) {
                    engine.clear(sheet, row, column);
                    row = engine.nextCell(sheet, column, row + 1, bottom);
                }
            }
        } else {
            for (let column = left; column <= right; column += 1) {
                for (let row = top; row <= bottom; row += 1) engine.setValue(sheet, row, column, value);
            }
        }
        extras.fill(rect, content ?? {});
    }
    for (const [row, column, content] of op.cells ?? []) {
        const value = content === null ? null : literalOf(content);
        if (content?.f !== undefined) engine.setFormula(sheet, row, column, content.f, value);
        else if (value === null) engine.clear(sheet, row, column);
        else engine.setValue(sheet, row, column, value);
        extras.write(row, column, content ?? {});
    }
    return [inputOf(sheet, gathered)];
}

// The ops that put back the text of every formula an edit bound to a sheet that took its name, one per sheet, each
// cell with the link, the mark and the given value it holds. They apply after the edit's own inverse, which frees
// the name: before it, the text would bind again.
export function lostInputs(book: Workbook, { rewrites }: EditResult): InputOp[] {
    const ops: InputOp[] = [];
    for (const [sheet, { extras }] of book.sheets) {
        const gathered: Gathered = { runs: [], cells: [] };
        for (const { sheet: on, top, left, bottom, right, lost } of rewrites) {
            if (on !== sheet || lost === null) continue;
            readBlock(book, sheet, extras, [top, left, bottom, right], (group) =>
                gather(gathered, group, { ...contentOfGroup(group), f: lost }),
            );
        }
        if (gathered.runs.length + gathered.cells.length > 0) ops.push(inputOf(sheet, gathered));
    }
    return ops;
}

// Reads a block a column at a time, down the cells the engine and the extras hold, and hands over each rectangle
// of equal content, or of empty cells, once it can grow no further. A run of equal content down a column joins the
// rectangle to its left that spans the same rows with the same content.
function readBlock(book: Workbook, sheet: string, extras: Extras, rect: Rect, close: (group: Group) => void): void {
    const { engine } = book;
    const [top, left, bottom, right] = rect;
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
            const { value, formula, given, extra } = group.held;
            const joins = before?.top === group.top && before.bottom === group.bottom;
            if (joins && holds(before.held, value, formula, given, extra)) {
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
    const cell = (row: number, at: number, value: Literal | null, formula: string | null, extra?: Extra) => {
        while (column < at) endColumn();
        gap(row - 1);
        next = row + 1;
        const given = formula !== null && engine.isGiven(sheet, row, at);
        const last = down.at(-1);
        if (last?.bottom === row - 1 && holds(last.held, value, formula, given, extra)) last.bottom = row;
        else down.push({ top: row, left: at, bottom: row, right: at, held: { value, formula, given, extra } });
    };
    // A cell that holds only a link or a mark is no cell of the engine's: it is read in its place among them.
    const marked = extras.cells(rect);
    let mark = marked.next();
    engine.cells(
        sheet,
        (row, at, value, formula) => {
            for (; !mark.done; mark = marked.next()) {
                const [r, c, extra] = mark.value;
                if (c > at || (c === at && r >= row)) break;
                cell(r, c, null, null, extra);
            }
            const here = !mark.done && mark.value[0] === row && mark.value[1] === at;
            cell(row, at, value, formula, here ? mark.value[2] : undefined);
            if (here) mark = marked.next();
        },
        top,
        left,
        bottom,
        right,
    );
    for (; !mark.done; mark = marked.next()) cell(mark.value[0], mark.value[1], null, null, mark.value[2]);
    while (column <= right) endColumn();
    for (const group of open) close(group);
}

// Whether a cell read holds what a run holds, compared on what an op would carry, without making a `Held` of it.
function holds(
    held: Held,
    value: Literal | null,
    formula: string | null,
    given: boolean,
    extra: Extra | undefined,
): boolean {
    if (held.formula !== formula || held.given !== given || !sameExtra(held.extra, extra)) return false;
    return (formula !== null && !given) || sameValue(held.value, value);
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

function sameJson(a: unknown, b: unknown): boolean {
    return a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));
}

function contentOfGroup({ held }: Group): CellContent | null {
    return contentOf(held.value, held.formula, held.given, held.extra);
}

// A rectangle of one cell goes into the list of cells, which says it in fewer bytes.
function gather({ runs, cells }: Gathered, { top, left, bottom, right }: Group, content: CellContent | null): void {
    if (top === bottom && left === right) cells.push([top, left, content]);
    else runs.push([[top, left, bottom, right], content]);
}

function inputOf(sheet: string, { runs, cells }: Gathered): InputOp {
    cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    return { kind: 'input', sheet, ...(runs.length > 0 && { runs }), ...(cells.length > 0 && { cells }) };
}

// The value a cell of this content holds, or null for none: the joined text of rich runs, an error literal, or the
// value as it is. Beside a formula it is the value given with it.
function literalOf({ v, e, s }: CellContent): Literal | null {
    if (s) return textOf(s);
    if (v === undefined) return null;
    return e && typeof v === 'string' ? errorOf(v) : v;
}
