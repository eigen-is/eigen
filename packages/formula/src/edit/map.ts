// Where a row or column index goes when rows or columns are inserted or deleted, the one rule for everything that
// holds such an index, such as a formula's references and the ranges of merges and charts.
// Both maps are blind to the axis, so the caller picks rows or columns and builds one edit for them. A span is never
// mapped as two single indices, because its ends clamp where a lone index would be gone.

// `count` lines inserted so that the first new one is line `index`, or the `count` lines from `index` on deleted, on
// an axis that holds `lines` lines.
export type Edit = { readonly insert: boolean; readonly index: number; readonly count: number; readonly lines: number };

// The caller's own, written by mapSpan, so that mapping a span allocates nothing.
export type Span = { start: number; end: number };

export const GONE = -1;

// GONE for a deleted line and for one an insert pushes past the last line.
export function mapIndex(edit: Edit, i: number): number {
    if (i < edit.index) return i;
    if (edit.insert) return i + edit.count < edit.lines ? i + edit.count : GONE;
    return i < edit.index + edit.count ? GONE : i - edit.count;
}

// Writes where the lines `start` to `end` are after the edit into `into`, or returns false when none is left. An end
// stops where a lone index would be gone: at the last line of the axis, or at the edge of the deleted lines.
export function mapSpan(edit: Edit, start: number, end: number, into: Span): boolean {
    const { index, count } = edit;
    if (edit.insert) {
        const last = edit.lines - 1;
        const moved = start < index ? start : start + count;
        if (moved > last) return false;
        into.start = moved;
        into.end = end < index ? end : Math.min(end + count, last);
        return true;
    }
    const after = index + count;
    if (start >= index && end < after) return false;
    into.start = start < index ? start : start < after ? index : start - count;
    into.end = end < index ? end : end < after ? index - 1 : end - count;
    return true;
}
