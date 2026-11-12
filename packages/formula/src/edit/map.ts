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

// The first line that `count` lines inserted at `index` push past the last of `lines` lines: from it on all are gone.
export function firstPushed(index: number, count: number, lines: number): number {
    return Math.max(index, lines - count);
}

// GONE for a deleted line and for one an insert pushes past the last line.
export function mapIndex(edit: Edit, i: number): number {
    const { index, count } = edit;
    if (i < index) return i;
    if (edit.insert) return i < firstPushed(index, count, edit.lines) ? i + count : GONE;
    return i < index + count ? GONE : i - count;
}

// Writes where the lines `start` to `end` are after the edit into `into`, or returns false when none is left. An end
// stops where a lone index would be gone: at the last line of the axis, or at the edge of the deleted lines.
export function mapSpan(edit: Edit, start: number, end: number, into: Span): boolean {
    const { index, count } = edit;
    if (edit.insert) {
        if (start >= firstPushed(index, count, edit.lines)) return false;
        into.start = start < index ? start : start + count;
        into.end = end < index ? end : Math.min(end + count, edit.lines - 1);
        return true;
    }
    const after = index + count;
    if (start >= index && end < after) return false;
    into.start = start < index ? start : start < after ? index : start - count;
    into.end = end < index ? end : end < after ? index - 1 : end - count;
    return true;
}
