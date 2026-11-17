// What is left of an undo when peers wrote after the edit it undoes: the part of the inverse whose targets still hold
// what the edit left. A cell's content, its runs and a formula a rename bound go back while the cell holds what the
// edit left there, a look or line key per cell or line while it has the value the edit gave it, a record's field while
// it has the value the edit set; where a peer wrote since, the peer's write stays and the inverse is cut around it.

import { bindSheet, parseStored, printStored } from '@workspace/formula/text';
import type { CellContent, FormatOp, InputOp, Op, RecordOp, Rect, Span } from '@workspace/lib/sheets/ops';
import { isStructural, LOOK_KEYS, RUN_KEYS } from '@workspace/lib/sheets/ops';
import { covers, intersect, outsideOf } from '@workspace/lib/sheets/rect';
import { Areas, keyOf, names, restyled } from './apply-format';
import { cellAt, entryAt, inputOf } from './apply-input';
import { LINE_KEYS } from './line-runs';
import type { BookSheet, Workbook } from './workbook';

type CellFormat = Extract<FormatOp, { ranges: unknown }>;
type LineFormat = Extract<FormatOp, { lines: unknown }>;
type Holds = (row: number, column: number) => boolean;

// `apply` is the inverse of `written`, both as the peers' line edits shifted them. An inverse that renumbers places
// comes back whole: the stack keeps such an entry only while no peer's batch landed.
export function stillHolding(book: Workbook, apply: readonly Op[], written: readonly Op[]): Op[] {
    const held: Op[] = [];
    const tests = new Map<string, Holds>();
    for (const op of apply) {
        if (isStructural(op)) return [...apply];
        const part = book.sheets.get(op.sheet);
        // An op on a sheet that is gone would be skipped.
        if (!part) continue;
        let holds = tests.get(op.sheet);
        if (!holds) {
            holds = asLeft(book, part, op.sheet, apply, written);
            tests.set(op.sheet, holds);
        }
        if (op.kind === 'input') {
            const next = inputHolding(op, holds);
            if (next) held.push(next);
        } else if (op.kind === 'record') {
            const next = recordHolding(book, op, written);
            if (next) held.push(next);
        } else if ('lines' in op) held.push(...linesHolding(part, op, written));
        else held.push(...cellsHolding(book, part, op, written, holds));
    }
    return held;
}

// Whether a cell holds what the edit left, folded from the inverse's last word on it, or what it holds now, through
// each written op; the inverse writes, restyles or rebinds a cell only then.
function asLeft(book: Workbook, part: BookSheet, sheet: string, apply: readonly Op[], written: readonly Op[]): Holds {
    const inputs = apply.filter((op): op is InputOp => op.kind === 'input' && op.sheet === sheet).toReversed();
    return (row, column) => {
        const now = cellAt(book, sheet, part.extras, row, column);
        let left = now;
        for (const op of inputs) {
            const entry = entryAt(op, row, column);
            if (entry === undefined) continue;
            left = entry;
            break;
        }
        let wrote = false;
        for (const op of written) {
            if (op.kind === 'record') {
                if (op.type !== 'sheet' || !op.set.name || left?.f === undefined) continue;
                const tree = parseStored(left.f);
                if ('reason' in tree) continue;
                const bound = bindSheet(tree, op.set.name, op.sheet);
                if (bound === tree) continue;
                // A formula a rename bound goes back only while the sheet has that name, or it would bind elsewhere.
                if (!book.sheets.has(op.sheet) || book.records.fields(op.sheet).name !== op.set.name) return false;
                left = { ...left, f: printStored(bound) };
                wrote = true;
            }
            if (op.kind === 'input' && op.sheet === sheet) {
                const entry = entryAt(op, row, column);
                if (entry === undefined) continue;
                left = entry;
                wrote = true;
            }
            if (op.kind !== 'format' || op.sheet !== sheet || !('ranges' in op)) continue;
            if (!op.ranges.some((rect) => covers(rect, row, column))) continue;
            const keys = RUN_KEYS.filter((key) => names(op, key));
            if (left?.s && keys.length > 0) {
                left = { ...left, s: restyled(left.s, keys, op.set ?? {}) };
                wrote = true;
            }
            if (names(op, 'link')) {
                const { link: _, ...rest } = left ?? {};
                left = op.set?.link ? { ...rest, link: op.set.link } : rest;
                wrote = true;
            }
        }
        if (!wrote) return true;
        const a = left ?? {};
        const b = now ?? {};
        if (a.f !== b.f || a.qp !== b.qp || !same(a.link, b.link) || !same(a.s, b.s)) return false;
        if (a.f !== undefined && b.v === undefined) return true;
        // A kept formula with no value reads #REF!.
        const value = ({ v, e, f }: CellContent) =>
            v === undefined || (f !== undefined && e && v === '#REF!') ? null : [v, e];
        return same(value(a), value(b));
    };
}

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// The cells of a rectangle that hold, joined into rectangles: the rectangle itself when all do.
function holding([top, left, bottom, right]: Rect, holds: Holds): Rect[] {
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

function inputHolding(op: InputOp, holds: Holds): InputOp | undefined {
    const runs = (op.runs ?? []).flatMap(([rect, before]) =>
        holding(rect, holds).map((piece) => [piece, before] as const),
    );
    const cells = (op.cells ?? []).filter(([row, column]) => holds(row, column));
    return inputOf(op.sheet, { runs, cells });
}

// What still holds of the ranges of one key, undefined when all does. Of each part a write of the edit covers, newest
// first, `check` gives what holds the value written, null for all of it; what no write covers stays.
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
                const both = intersect(piece, rect);
                if (!both) return [piece];
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
// A run-style key restyles every rich cell it covers, so it leaves out each one that does not hold what the edit left.
function cellsHolding(
    book: Workbook,
    part: BookSheet,
    op: CellFormat,
    written: readonly Op[],
    holds: Holds,
): FormatOp[] {
    const { sheet } = op;
    const formats = written
        .filter((other): other is CellFormat => other.kind === 'format' && other.sheet === sheet && 'ranges' in other)
        .toReversed();
    const changed = RUN_KEYS.some((key) => names(op, key))
        ? op.ranges.flatMap((rect) =>
              part.extras.cells(rect).filter(([row, column, { s }]) => s && !holds(row, column)),
          )
        : [];
    const parts: FormatOp[] = [];
    let whole = true;
    for (const key of LOOK_KEYS.filter((name) => names(op, name))) {
        const writes = formats
            .filter((other) => names(other, key))
            .map((other) => ({ ranges: other.ranges, value: other.set?.[key] }));
        let ranges = heldOf(op.ranges, writes, (rect, value) => {
            const areas = new Areas();
            let all = true;
            for (const { c0, c1, r0, r1, look } of part.bands.spans(rect)) {
                if (keyOf(book.looks.look(look)[key]) === keyOf(value)) areas.add(r0, c0, r1, c1);
                else all = false;
            }
            return all ? null : areas.joined();
        });
        if (changed.length > 0 && RUN_KEYS.some((name) => name === key)) {
            for (const [row, column] of changed) {
                ranges = (ranges ?? op.ranges).flatMap((rect) => outsideOf(rect, [row, column, row, column]));
            }
        }
        if (ranges) whole = false;
        const set = op.set?.[key] === undefined ? { clear: [key] } : { set: { [key]: op.set[key] } };
        if ((ranges ?? op.ranges).length > 0)
            parts.push({ kind: 'format', sheet, ranges: ranges ?? op.ranges, ...set });
    }
    if (names(op, 'link')) {
        const ranges = op.ranges.flatMap((rect) => holding(rect, holds));
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
function recordHolding(book: Workbook, op: RecordOp, written: readonly Op[]): RecordOp | undefined {
    let id = op.id;
    // A make of any filter takes the place of the live one; a change or delete writes only the record of its id.
    const slot = (other: RecordOp) => other.id === id || (other.type === 'filter' && other.whole === 1);
    const ofSheet = written.filter((other): other is RecordOp => other.kind === 'record' && other.sheet === op.sheet);
    // A filter's columns go and come with it, whatever the edit's own ops on them say.
    if (op.type === 'filterColumn' && ofSheet.some((other) => other.type === 'filter')) return op;
    let known: { [field: string]: unknown } = {};
    // What the edit said of the record last: that it is gone, every field of it, or only the fields in `known`.
    let state: 'gone' | 'whole' | 'fields' | undefined;
    for (const other of ofSheet) {
        if (other.type !== op.type || !slot(other)) continue;
        if (!other.set) state = 'gone';
        else if (other.whole) state = 'whole';
        else state ??= 'fields';
        known = other.set && !other.whole ? { ...known, ...other.set } : { ...other.set };
        id = other.id;
    }
    if (!state) return op;
    const { records } = book;
    const [filter] = records.records(op.sheet, 'filter');
    const live =
        op.type === 'sheet'
            ? records.fields(op.sheet)
            : op.type !== 'filter'
              ? records.records(op.sheet, op.type).get(id)
              : filter && (state === 'gone' || filter[0] === id)
                ? filter[1]
                : undefined;
    const fields = new Map(Object.entries(live ?? {}));
    const holds = (field: string) => !(state === 'whole' || field in known) || same(fields.get(field), known[field]);
    if (op.set && !op.whole) return live ? heldFields(op, op.set, holds) : undefined;
    if (state === 'gone') return live ? undefined : op;
    const kept = live && Object.keys(known).every(holds) && (state !== 'whole' || [...fields.keys()].every(holds));
    return kept ? op : undefined;
}

// The op with the fields of its `set` that hold: the op itself with all of them, none with no field.
function heldFields<O extends RecordOp, S extends NonNullable<O['set']>>(
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
