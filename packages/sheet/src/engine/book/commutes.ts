// Whether batches the log orders before batches this workbook already holds can land on top of them as they are: a
// tab applies its own edits at once, so a peer's batch the server put first arrives late. A yes promises the bytes of
// the log's order once the clock is its last batch's, each refusal alike in both orders and none by the limits, and
// inverses that apply alike, though their rectangles may follow another band layout. It says no when two ops write
// one thing, or the late ops and the inverses might pass a limit.

import { fits } from '@workspace/lib/sheets/limits';
import type { Op, Rect, Span } from '@workspace/lib/sheets/ops';
import { isStructural, LOOK_KEYS, RUN_KEYS } from '@workspace/lib/sheets/ops';
import { apart } from '@workspace/lib/sheets/rect';
import { names } from './apply-format';
import { filled } from './apply-input';
import type { Extras } from './extras';
import { unitsOf } from './extras';
import { LINE_KEYS } from './line-runs';
import type { Workbook } from './workbook';

// `book` holds `applied`, every batch of which landed, and `inverses` are the inverses those batches returned. The
// ops of `late` are in no particular order with them: an op of an inverse counts as an op of its batch.
export function commutes(
    book: Workbook,
    late: readonly Op[],
    applied: readonly Op[],
    inverses: readonly Op[],
): boolean {
    const held = [...applied, ...inverses];
    // A structural op renumbers places, so it clashes with any op, and a late one even with nothing held.
    if (late.some(isStructural) || (late.length > 0 && held.some(isStructural))) return false;
    if (meet(book, sideOf(late), sideOf(held))) return false;
    // The most the workbook can weigh once the late ops and the inverses land, in any order and when only some do: its
    // weight now, plus per sheet the rows each written column may come to hold and the columns each cell format writes.
    const written = new Map<string, { lengths: Map<number, number>; formats: Span[] }>();
    const of = (sheet: string) => {
        let entry = written.get(sheet);
        if (!entry) {
            entry = { lengths: new Map(), formats: [] };
            written.set(sheet, entry);
        }
        return entry;
    };
    const now = book.weight();
    let { slots, runs, bands, extras, records } = now;
    for (const op of [...late, ...inverses]) {
        if (op.kind === 'record') records += op.whole ? 1 : 0;
        if (op.kind === 'input') {
            const { lengths } = of(op.sheet);
            extras += filled(op, (column, length) => lengths.set(column, Math.max(lengths.get(column) ?? 0, length)));
        }
        if (op.kind === 'format' && 'ranges' in op) {
            const { link } = op.set ?? {};
            for (const [top, left, bottom, right] of op.ranges) {
                if (link) extras += unitsOf({ link }) * (bottom - top + 1) * (right - left + 1);
                if (LOOK_KEYS.some((key) => names(op, key))) of(op.sheet).formats.push([left, right]);
            }
        }
    }
    for (const [sheet, { lengths, formats }] of written) {
        const part = book.sheets.get(sheet);
        // An op on a sheet that is gone is skipped.
        if (!part) continue;
        for (const [column, length] of lengths) {
            slots += Math.max(0, length - book.engine.columnLength(sheet, column));
        }
        const growth = part.bands.growth(formats);
        runs += growth.runs;
        bands += growth.bands;
    }
    return fits({ slots, runs, bands, extras, records, sheets: now.sheets }) === null;
}

// What the ops of one side write per sheet, as rectangles a sweep sets against the other side's, and what their records
// name. A line format's span is a rectangle one column wide.
type Writes = {
    inputs: Rect[];
    rich: Rect[];
    restyles: Rect[];
    keys: Map<string, Rect[]>;
    lines: Map<string, Rect[]>;
};
type Side = {
    sheets: Map<string, Writes>;
    inputs: boolean;
    renames: boolean;
    hides: boolean;
    showsOrHides: boolean;
    ids: Set<string>;
    merges: Set<string>;
    filters: Set<string>;
    filterParts: Set<string>;
};

function sideOf(ops: readonly Op[]): Side {
    const side: Side = {
        sheets: new Map(),
        inputs: false,
        renames: false,
        hides: false,
        showsOrHides: false,
        ids: new Set(),
        merges: new Set(),
        filters: new Set(),
        filterParts: new Set(),
    };
    const on = (sheet: string) => {
        let writes = side.sheets.get(sheet);
        if (!writes) {
            writes = { inputs: [], rich: [], restyles: [], keys: new Map(), lines: new Map() };
            side.sheets.set(sheet, writes);
        }
        return writes;
    };
    const listOf = <K>(lists: Map<K, Rect[]>, key: K) => {
        const list = lists.get(key) ?? [];
        lists.set(key, list);
        return list;
    };
    for (const op of ops) {
        if (op.kind === 'input') {
            side.inputs = true;
            const { inputs, rich } = on(op.sheet);
            for (const [rect, content] of op.runs ?? []) {
                inputs.push(rect);
                if (content?.s) rich.push(rect);
            }
            for (const [row, column, content] of op.cells ?? []) {
                inputs.push([row, column, row, column]);
                if (content?.s) rich.push([row, column, row, column]);
            }
        } else if (op.kind === 'format' && 'lines' in op) {
            const { lines } = on(op.sheet);
            const spans = op.spans.map(([first, last]): Rect => [first, 0, last, 0]);
            for (const key of LINE_KEYS) {
                if (names(op, key)) listOf(lines, `${op.lines} ${key}`).push(...spans);
            }
        } else if (op.kind === 'format') {
            const { keys, restyles } = on(op.sheet);
            const named = Object.entries(op.set ?? {}).flatMap(([key, value]) => (value === undefined ? [] : [key]));
            for (const key of new Set([...named, ...(op.clear ?? [])])) listOf(keys, key).push(...op.ranges);
            if (RUN_KEYS.some((key) => names(op, key))) restyles.push(...op.ranges);
        } else if (op.kind === 'record') {
            if (op.type === 'sheet') {
                side.renames ||= op.set.name !== undefined;
                side.hides ||= op.set.hide === 1;
                side.showsOrHides ||= op.set.hide !== undefined;
            }
            side.ids.add(`${op.type} ${op.id}`);
            if (op.type === 'merge') side.merges.add(op.sheet);
            if (op.type === 'filter') side.filters.add(op.sheet);
            if (op.type === 'filter' || op.type === 'filterColumn') side.filterParts.add(op.sheet);
        }
    }
    return side;
}

// Whether an op of each side writes one thing, so their order shows in the bytes, a refusal or an inverse. A record op
// also reads others: merges, the live filter and its columns, the names in use, and whether another sheet is shown.
function meet(book: Workbook, a: Side, b: Side): boolean {
    if ((a.renames && (b.renames || b.inputs)) || (b.renames && a.inputs)) return true;
    if ((a.hides && b.showsOrHides) || (b.hides && a.showsOrHides)) return true;
    if (!a.ids.isDisjointFrom(b.ids) || !a.merges.isDisjointFrom(b.merges)) return true;
    if (!a.filters.isDisjointFrom(b.filterParts) || !b.filters.isDisjointFrom(a.filterParts)) return true;
    for (const [sheet, mine] of a.sheets) {
        const theirs = b.sheets.get(sheet);
        if (theirs && writesMeet(book.sheets.get(sheet)?.extras, mine, theirs)) return true;
    }
    return false;
}

// An input replaces a link, and a run-style key restyles a rich cell, one an input writes or one the sheet holds now,
// which is how a cell that was rich when a format landed reads here. A sheet that is gone holds no cell to format.
function writesMeet(extras: Extras | undefined, a: Writes, b: Writes): boolean {
    if (!apart(a.inputs, b.inputs)) return true;
    for (const [key, spans] of a.lines) if (!apart(spans, b.lines.get(key) ?? [])) return true;
    if (!extras) return false;
    for (const [key, ranges] of a.keys) if (!apart(ranges, b.keys.get(key) ?? [])) return true;
    const aLinks = a.keys.get('link') ?? [];
    const bLinks = b.keys.get('link') ?? [];
    if (!apart(a.inputs, bLinks) || !apart(b.inputs, aLinks)) return true;
    if (!apart(a.rich, b.restyles) || !apart(b.rich, a.restyles)) return true;
    // The inverse of a format writes back the runs of a rich cell whole, with what the other format made of them.
    const richNow = (ranges: readonly Rect[]) =>
        ranges.flatMap((range) =>
            extras.cells(range).flatMap(([row, column, { s }]): Rect[] => (s ? [[row, column, row, column]] : [])),
        );
    const meetsRich = (restyles: readonly Rect[], others: readonly Rect[]) =>
        restyles.length > 0 && others.length > 0 && !apart(richNow(restyles), others);
    return (
        meetsRich(a.restyles, [...b.inputs, ...b.restyles, ...bLinks]) ||
        meetsRich(b.restyles, [...a.inputs, ...aLinks])
    );
}
