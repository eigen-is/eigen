// Whether batches the log orders before batches this workbook already holds can land on top of them as they are: a
// tab applies its own edits at once, so a peer's batch the server put first arrives late. A yes promises the bytes of
// the log's order once the clock is its last batch's, each refusal alike in both orders and none by the limits, and
// inverses that apply alike, though their rectangles may follow another band layout. It says no when two ops write
// one thing, or the late ops and the inverses might pass a limit.

import type { WorkbookWeight } from '@workspace/lib/sheets/limits';
import { fits } from '@workspace/lib/sheets/limits';
import type { FormatOp, InputOp, Op, RecordOp, Rect, Span } from '@workspace/lib/sheets/ops';
import { isStructural, LOOK_KEYS } from '@workspace/lib/sheets/ops';
import { covers, meets } from '@workspace/lib/sheets/rect';
import { names, RUN_KEYS } from './apply-format';
import { entryAt } from './apply-input';
import type { Extras } from './extras';
import { unitsOf } from './extras';
import { LINE_KEYS } from './line-runs';
import type { Workbook } from './workbook';

type CellFormat = Extract<FormatOp, { ranges: unknown }>;

// `book` holds `applied`, every batch of which landed, and `inverses` are the inverses those batches returned. The
// ops of `late` are in no particular order with them: an op of an inverse counts as an op of its batch.
export function commutes(
    book: Workbook,
    late: readonly Op[],
    applied: readonly Op[],
    inverses: readonly Op[],
): boolean {
    const held = [...applied, ...inverses];
    // A structural op the workbook holds clashes with every late op.
    if (late.some(isStructural)) return false;
    for (const op of late) {
        for (const other of held) if (clash(book, op, other)) return false;
    }
    return fits(weightBound(book, [...late, ...inverses])) === null;
}

// The most the workbook can weigh once ops that renumber no place land on it, in whatever order and when only some
// of them do: each count of its weight now, and the most the ops can add to it.
function weightBound(book: Workbook, ops: readonly Op[]): WorkbookWeight {
    // Per sheet, the rows each written column may come to hold and the columns each cell format writes.
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
    for (const op of ops) {
        if (op.kind === 'record') records += op.whole ? 1 : 0;
        if (op.kind === 'input') {
            const { lengths } = of(op.sheet);
            for (const [[top, left, bottom, right], content] of op.runs ?? []) {
                if (!content) continue;
                for (let column = left; column <= right; column += 1) {
                    lengths.set(column, Math.max(lengths.get(column) ?? 0, bottom + 1));
                }
                extras += unitsOf(content) * (bottom - top + 1) * (right - left + 1);
            }
            for (const [row, column, content] of op.cells ?? []) {
                if (!content) continue;
                lengths.set(column, Math.max(lengths.get(column) ?? 0, row + 1));
                extras += unitsOf(content);
            }
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
    return { slots, runs, bands, extras, records, sheets: now.sheets };
}

// Whether two ops write one thing, so that their order shows in the bytes, in a refusal or in an inverse.
function clash(book: Workbook, a: Op, b: Op): boolean {
    if (a.kind === 'input') {
        if (b.kind === 'input') {
            return (
                a.sheet === b.sheet &&
                ((a.cells ?? []).some(([row, column]) => entryAt(b, row, column) !== undefined) ||
                    (b.cells ?? []).some(([row, column]) => a.runs?.some(([rect]) => covers(rect, row, column))) ||
                    (a.runs ?? []).some(([rect]) => b.runs?.some(([other]) => meets(rect, other))))
            );
        }
        if (b.kind === 'format') return inputMeetsFormat(book, a, b);
        return b.kind !== 'record' || renames(b);
    }
    if (a.kind === 'format') {
        if (b.kind === 'input') return inputMeetsFormat(book, b, a);
        if (b.kind === 'format') return formatsMeet(book, a, b);
        return b.kind !== 'record';
    }
    if (a.kind === 'record') {
        if (b.kind === 'input') return renames(a);
        if (b.kind === 'record') return recordsMeet(a, b);
        return b.kind !== 'format';
    }
    return true;
}

// An input replaces a cell's link, and a format's run-style key restyles the runs of a rich cell: one the input
// writes, or one the cell holds now, which is how a cell that was rich when the format landed reads here.
function inputMeetsFormat(book: Workbook, input: InputOp, format: FormatOp): boolean {
    const extras = book.sheets.get(input.sheet)?.extras;
    if (input.sheet !== format.sheet || !('ranges' in format) || !extras) return false;
    const linked = names(format, 'link');
    if (!linked && !RUN_KEYS.some((key) => names(format, key))) return false;
    return format.ranges.some(
        (range) =>
            (input.cells ?? []).some(
                ([row, column, content]) =>
                    covers(range, row, column) && (linked || content?.s || extras.at(row, column)?.s),
            ) ||
            (input.runs ?? []).some(
                ([rect, content]) => meets(range, rect) && (linked || content?.s || richIn(extras, range, rect)),
            ),
    );
}

function formatsMeet(book: Workbook, a: FormatOp, b: FormatOp): boolean {
    if (a.sheet !== b.sheet) return false;
    if ('lines' in a || 'lines' in b) {
        if (!('lines' in a && 'lines' in b) || a.lines !== b.lines) return false;
        const shared = LINE_KEYS.some((key) => names(a, key) && names(b, key));
        return shared && a.spans.some((x) => b.spans.some((y) => x[0] <= y[1] && y[0] <= x[1]));
    }
    const extras = book.sheets.get(a.sheet)?.extras;
    if (!extras) return false;
    const shared = [...LOOK_KEYS, 'link' as const].some((key) => names(a, key) && names(b, key));
    // The inverse of a format writes back the runs of a rich cell whole, with what the other format made of them.
    const restyles = (op: CellFormat) => RUN_KEYS.some((key) => names(op, key));
    const rich = restyles(a) ? restyles(b) || names(b, 'link') : restyles(b) && names(a, 'link');
    if (!shared && !rich) return false;
    return a.ranges.some((x) => b.ranges.some((y) => meets(x, y) && (shared || richIn(extras, x, y))));
}

// Beyond one record, the store reads its other records: a merge may not lie on another, a new filter takes the place
// of the live one and its columns, a name may be in use, and a sheet may be hidden only while another is shown.
function recordsMeet(a: RecordOp, b: RecordOp): boolean {
    if (a.type === 'sheet' && b.type === 'sheet') {
        if (renames(a) && renames(b)) return true;
        if ((a.set.hide === 1 && b.set.hide !== undefined) || (b.set.hide === 1 && a.set.hide !== undefined)) {
            return true;
        }
    }
    if (a.sheet !== b.sheet) return false;
    if (a.type === b.type && (a.id === b.id || a.type === 'merge')) return true;
    const filters = (op: RecordOp) => op.type === 'filter' || op.type === 'filterColumn';
    return filters(a) && filters(b) && (a.type === 'filter' || b.type === 'filter');
}

// A new name binds the formulas typed with it, which an input may be writing.
function renames(op: RecordOp): boolean {
    return op.type === 'sheet' && op.set.name !== undefined;
}

// Whether a cell that both rectangles hold is rich.
function richIn(extras: Extras, a: Rect, b: Rect): boolean {
    const both: Rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
    for (const [, , extra] of extras.cells(both)) if (extra.s) return true;
    return false;
}
