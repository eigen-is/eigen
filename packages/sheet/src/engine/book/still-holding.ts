// What is left of an undo when peers wrote after the edit it undoes: the part of the inverse whose targets still hold
// what the edit left. A cell stays while it holds the content the edit wrote, a look or line key per cell or line
// while it has the value the edit gave it, a record's field while it has the value the edit set; where a peer wrote
// since, the peer's write stays and the inverse is cut around it. What the edit left is read off its ops, so a target
// none of them names, such as a formula a rename bound, stays in the inverse as it is.

import type { CellContent, FormatOp, InputOp, Op, RecordOp, Rect, Span } from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import { covers } from '@workspace/lib/sheets/rect';
import { Areas, keyOf, names, RUN_KEYS, restyled } from './apply-format';
import { cellAt, entryAt } from './apply-input';
import { outsideOf } from './apply-move';
import { LINE_KEYS } from './line-runs';
import type { BookSheet, Workbook } from './workbook';

type CellFormat = Extract<FormatOp, { ranges: unknown }>;
type LineFormat = Extract<FormatOp, { lines: unknown }>;

// `apply` is the inverse of `written`, both as the peers' line edits shifted them. An inverse that renumbers places
// comes back whole: the stack keeps such an entry only while no peer's batch landed.
export function stillHolding(book: Workbook, apply: readonly Op[], written: readonly Op[]): Op[] {
    const held: Op[] = [];
    for (const op of apply) {
        if (op.kind === 'lines' || op.kind === 'move' || op.kind === 'sheet') return [...apply];
        const part = book.sheets.get(op.sheet);
        // An op on a sheet that is gone would be skipped.
        if (!part) continue;
        if (op.kind === 'input') {
            const next = inputHolding(book, part, op, written);
            if (next) held.push(next);
        } else if (op.kind === 'record') {
            const next = recordHolding(part, op, written);
            if (next) held.push(next);
        } else if ('lines' in op) held.push(...linesHolding(part, op, written));
        else held.push(...cellsHolding(book, part, op, written));
    }
    return held;
}

// What the edit left in a cell that held `before`, or undefined when no op of it wrote the cell's content or link.
// Every op is folded in, the ones before the state `before` is of too: an input replaces the cell and a format sets
// keys, so they give the same content again.
function leftIn(
    written: readonly Op[],
    sheet: string,
    row: number,
    column: number,
    before: CellContent | null,
): CellContent | null | undefined {
    let content = before;
    let wrote = false;
    for (const op of written) {
        if (op.kind === 'input' && op.sheet === sheet) {
            const entry = entryAt(op, row, column);
            if (entry === undefined) continue;
            content = entry;
            wrote = true;
        }
        if (op.kind !== 'format' || op.sheet !== sheet || !('ranges' in op)) continue;
        if (!op.ranges.some((rect) => covers(rect, row, column))) continue;
        const keys = RUN_KEYS.filter((key) => names(op, key));
        if (content?.s && keys.length > 0) {
            content = { ...content, s: restyled(content.s, keys, op.set ?? {}) };
            wrote = true;
        }
        if (names(op, 'link')) {
            const { link: _, ...rest } = content ?? {};
            content = op.set?.link ? { ...rest, link: op.set.link } : rest;
            wrote = true;
        }
    }
    return wrote ? content : undefined;
}

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// Whether a cell holds what an op said: a value beside a formula counts only where the workbook keeps one, and a
// kept formula with no value reads #REF!.
function sameContent(said: CellContent | null, held: CellContent | null): boolean {
    const a = said ?? {};
    const b = held ?? {};
    if (a.f !== b.f || a.qp !== b.qp || !same(a.link, b.link) || !same(a.s, b.s)) return false;
    if (a.f !== undefined && b.v === undefined) return true;
    const value = ({ v, e, f }: CellContent) =>
        v === undefined || (f !== undefined && e && v === '#REF!') ? null : [v, e];
    return same(value(a), value(b));
}

// The cells of a rectangle that hold, joined into rectangles: the rectangle itself when all do.
function holding([top, left, bottom, right]: Rect, holds: (row: number, column: number) => boolean): Rect[] {
    const areas = new Areas();
    for (let column = left; column <= right; column += 1) {
        let from = -1;
        for (let row = top; row <= bottom + 1; row += 1) {
            const held = row <= bottom && holds(row, column);
            if (held && from < 0) from = row;
            if (!held && from >= 0) {
                areas.add(from, column, row - 1, column);
                from = -1;
            }
        }
    }
    return areas.joined();
}

function inputHolding(book: Workbook, part: BookSheet, op: InputOp, written: readonly Op[]): InputOp | undefined {
    const { sheet } = op;
    const holds = (row: number, column: number, before: CellContent | null) => {
        const left = leftIn(written, sheet, row, column, before);
        return left === undefined || sameContent(left, cellAt(book, sheet, part.extras, row, column));
    };
    const runs = (op.runs ?? []).flatMap(([rect, before]) =>
        holding(rect, (row, column) => holds(row, column, before)).map((piece) => [piece, before] as const),
    );
    const cells = (op.cells ?? []).filter(([row, column, before]) => holds(row, column, before));
    if (runs.length + cells.length === 0) return undefined;
    return { kind: 'input', sheet, ...(runs.length > 0 && { runs }), ...(cells.length > 0 && { cells }) };
}

// What still holds of the ranges of one key. The edit's writes of the key are read newest first: where one covers a
// part of a range, `check` gives the parts of it that hold the value written there, or null when all of it does, and
// what no write covers stays. Undefined when every part holds.
function heldOf<V>(
    ranges: readonly Rect[],
    writes: readonly { ranges: readonly Rect[]; value: V }[],
    check: (rect: Rect, value: V) => Rect[] | null,
): Rect[] | undefined {
    const held: Rect[] = [];
    let cut = false;
    let open = [...ranges];
    for (const { ranges: over, value } of writes) {
        for (const rect of over) {
            open = open.flatMap((piece) => {
                const [top, left, bottom, right] = piece;
                const both: Rect = [
                    Math.max(top, rect[0]),
                    Math.max(left, rect[1]),
                    Math.min(bottom, rect[2]),
                    Math.min(right, rect[3]),
                ];
                if (both[0] > both[2] || both[1] > both[3]) return [piece];
                const parts = check(both, value);
                if (parts) cut = true;
                held.push(...(parts ?? [both]));
                return outsideOf(piece, rect);
            });
        }
    }
    return cut ? [...held, ...open] : undefined;
}

// A cell format is cut per key: a look key over the spans of the bands, a link cell by cell, as few cells hold one.
function cellsHolding(book: Workbook, part: BookSheet, op: CellFormat, written: readonly Op[]): FormatOp[] {
    const { sheet } = op;
    const formats = written
        .filter((other): other is CellFormat => other.kind === 'format' && other.sheet === sheet && 'ranges' in other)
        .toReversed();
    const parts: FormatOp[] = [];
    let whole = true;
    for (const key of LOOK_KEYS.filter((name) => names(op, name))) {
        const writes = formats
            .filter((other) => names(other, key))
            .map((other) => ({ ranges: other.ranges, value: other.set?.[key] }));
        const ranges = heldOf(op.ranges, writes, (rect, value) => {
            const areas = new Areas();
            let all = true;
            for (const { c0, c1, r0, r1, look } of part.bands.spans(rect)) {
                if (keyOf(book.looks.look(look)[key]) === keyOf(value)) areas.add(r0, c0, r1, c1);
                else all = false;
            }
            return all ? null : areas.joined();
        });
        if (ranges) whole = false;
        const set = op.set?.[key] === undefined ? { clear: [key] } : { set: { [key]: op.set[key] } };
        if ((ranges ?? op.ranges).length > 0)
            parts.push({ kind: 'format', sheet, ranges: ranges ?? op.ranges, ...set });
    }
    if (names(op, 'link')) {
        const ranges = op.ranges.flatMap((rect) =>
            holding(rect, (row, column) => {
                const left = leftIn(written, sheet, row, column, null);
                return left === undefined || same(left?.link, part.extras.at(row, column)?.link);
            }),
        );
        if (!same(ranges, op.ranges)) whole = false;
        const set = op.set?.link ? { set: { link: op.set.link } } : { clear: ['link' as const] };
        if (ranges.length > 0) parts.push({ kind: 'format', sheet, ranges, ...set });
    }
    return whole ? [op] : parts;
}

function linesHolding(part: BookSheet, op: LineFormat, written: readonly Op[]): FormatOp[] {
    const { sheet, lines } = op;
    const runs = lines === 'rows' ? part.rows : part.columns;
    const formats = written
        .filter(
            (other): other is LineFormat =>
                other.kind === 'format' && other.sheet === sheet && 'lines' in other && other.lines === lines,
        )
        .toReversed();
    const across = ([first, last]: Span): Rect => [first, 0, last, 0];
    const parts: FormatOp[] = [];
    let whole = true;
    for (const key of LINE_KEYS.filter((name) => names(op, name))) {
        const writes = formats
            .filter((other) => names(other, key))
            .map((other) => ({ ranges: other.spans.map(across), value: other.set?.[key] }));
        const ranges = heldOf(op.spans.map(across), writes, ([first, , last], value) => {
            const held: Rect[] = [];
            let all = true;
            for (const [span, attrs] of runs.tiles(first, last)) {
                if (attrs[key] === value) held.push(across(span));
                else all = false;
            }
            return all ? null : held;
        });
        if (ranges) whole = false;
        const spans = ranges?.map(([first, , last]): Span => [first, last]) ?? op.spans;
        const set = op.set?.[key] === undefined ? { clear: [key] } : { set: { [key]: op.set[key] } };
        if (spans.length > 0) parts.push({ kind: 'format', sheet, lines, spans, ...set });
    }
    return whole ? [op] : parts;
}

// A record holds field by field where the inverse sets fields, and whole where it makes or deletes the record: then
// the record must be as the edit left it, or the peer's record stays. A sheet has one filter, whatever its id.
function recordHolding(part: BookSheet, op: RecordOp, written: readonly Op[]): RecordOp | undefined {
    const slot = (other: RecordOp) => other.type === 'filter' || other.id === op.id;
    const ofSheet = written.filter((other): other is RecordOp => other.kind === 'record' && other.sheet === op.sheet);
    // A filter's columns go and come with it, whatever the edit's own ops on them say.
    if (op.type === 'filterColumn' && ofSheet.some((other) => other.type === 'filter')) return op;
    let known: { [field: string]: unknown } = {};
    // What the edit said of the record last: that it is gone, every field of it, or only the fields in `known`.
    let state: 'gone' | 'whole' | 'fields' | undefined;
    let id = op.id;
    for (const other of ofSheet) {
        if (other.type !== op.type || !slot(other)) continue;
        if (!other.set) state = 'gone';
        else if (other.whole) state = 'whole';
        else state ??= 'fields';
        known = other.set && !other.whole ? { ...known, ...other.set } : { ...other.set };
        id = other.id;
    }
    if (!state) return op;
    const { records } = part;
    const [filter] = records.records('filter');
    const live =
        op.type === 'sheet'
            ? records.fields
            : op.type !== 'filter'
              ? records.records(op.type).get(id)
              : filter && (state === 'gone' || filter[0] === id)
                ? filter[1]
                : undefined;
    const fields = new Map(Object.entries(live ?? {}));
    const holds = (field: string) => !(state === 'whole' || field in known) || same(fields.get(field), known[field]);
    if (op.set && !op.whole) return live ? withFields(op, op.set, holds) : undefined;
    if (state === 'gone') return live ? undefined : op;
    const asLeft = live && Object.keys(known).every(holds) && (state !== 'whole' || [...fields.keys()].every(holds));
    return asLeft ? op : undefined;
}

// The op with the fields of its `set` that hold: the op itself with all of them, none with no field.
function withFields<O extends RecordOp, S extends NonNullable<O['set']>>(
    op: O,
    set: S,
    holds: (field: string) => boolean,
): O | undefined {
    const kept = { ...set };
    for (const field in kept) if (!holds(field)) delete kept[field];
    const count = Object.keys(kept).length;
    if (count === Object.keys(set).length) return op;
    return count > 0 ? { ...op, set: kept } : undefined;
}
