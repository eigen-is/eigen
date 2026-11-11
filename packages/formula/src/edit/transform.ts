// What a formula's stored text becomes when rows or columns are inserted or deleted: each reference keeps naming the
// cells it named, wherever they went. An absolute index goes through the edit's map on the target's sheet, and an
// offset becomes the distance between the mapped target and the mapped host, each on its own sheet. A formula only
// depends on its host through the host's line on the edited axis, so hostClasses cuts a span of host lines into
// stretches with one outcome each and the store transforms a filled column once per stretch, not once per cell.

import type { FormulaNode } from '../text/tree';
import { NodeKind, RefFlag, RefKind, referenceNode } from '../text/tree';
import { broken, mapLeaves, sheetOf } from './leaves';
import type { Edit, Span } from './map';
import { GONE, mapIndex, mapSpan } from './map';

// Rows or columns inserted or deleted on one sheet, named by its id.
export type LineEdit = Edit & { readonly sheet: string; readonly rows: boolean };

export type Transformed = {
    // The tree that went in when the stored text stays as it is.
    readonly tree: FormulaNode;
    // The old text cannot be derived back from the new: undo must keep it.
    readonly lossy: boolean;
    // A cell the formula read is gone, or lines shifted inside a whole column or row it reads: the value can change
    // whatever the formula computes, so it is a seed of the recompute.
    readonly recompute: boolean;
    // A range that is still a range spans another number of lines at this host than it did. Every cell it reads kept
    // its value, so the formula is a seed only when its shape depends on the size of a range, as ROWS, MATCH and
    // INDEX do and a sum does not. That, and a formula that reads its own position, is the caller's to decide.
    readonly resized: boolean;
};

// The hosts on the lines `start` to `end`, counted before the edit, which all get this outcome.
export type HostClass = Transformed & { readonly start: number; readonly end: number };

// `host` is the formula's own row for a row edit and its column for a column edit, before the edit. The host
// itself must survive the edit.
export function transformLines(tree: FormulaNode, edit: LineEdit, hostSheet: string, host: number): Transformed {
    const { tree: mapped, lossy, recompute, resized } = shift(tree, edit, hostSheet, host);
    return { tree: mapped, lossy, recompute, resized };
}

// The outcomes for the hosts of one formula on the lines `from` to `to` of one sheet, in order. Lines whose host
// the edit removes are left out. `references` are the tree's reference leaves.
export function hostClasses(
    tree: FormulaNode,
    references: readonly FormulaNode[],
    edit: LineEdit,
    hostSheet: string,
    from: number,
    to: number,
): HostClass[] {
    const { rows, index, lines } = edit;
    const second = edit.insert ? lines - edit.count : index + edit.count;
    const hostOnSheet = hostSheet === edit.sheet;
    const absolute = rows ? RefFlag.RowAbsolute : RefFlag.ColumnAbsolute;
    const absolute2 = rows ? RefFlag.Row2Absolute : RefFlag.Column2Absolute;
    // A class starts where the host, or a target that travels with it, crosses a line the edit treats differently.
    const starts = [from];
    if (hostOnSheet) starts.push(index, second);
    for (const reference of references) {
        const { op, flags } = reference;
        if (op === (rows ? RefKind.Columns : RefKind.Rows) || sheetOf(reference, hostSheet) !== edit.sheet) continue;
        for (const line of [0, lines, index, second]) {
            if ((flags & absolute) === 0) starts.push(line - (rows ? reference.row : reference.column));
            if (op !== RefKind.Cell && (flags & absolute2) === 0) {
                starts.push(line - (rows ? reference.row2 : reference.column2));
            }
        }
    }
    starts.sort((a, b) => a - b);
    const classes: HostClass[] = [];
    for (let i = 0; i < starts.length; i += 1) {
        const start = starts[i];
        if (start < from || start > to || start === starts[i + 1]) continue;
        if (hostOnSheet && mapIndex(edit, start) === GONE) continue;
        const end = i + 1 < starts.length ? Math.min(to, starts[i + 1] - 1) : to;
        for (let host = start; host <= end; ) {
            const { tree: mapped, lossy, recompute, resized, perHost } = shift(tree, edit, hostSheet, host);
            const last = perHost ? host : end;
            classes.push({ start: host, end: last, tree: mapped, lossy, recompute, resized });
            host = last + 1;
        }
    }
    return classes;
}

// `perHost` says an end that travels with the host was cut off at a fixed line, so the next host differs.
function shift(tree: FormulaNode, edit: LineEdit, hostSheet: string, host: number) {
    const { rows, index, count, lines } = edit;
    const after = index + count;
    const hostAfter = hostSheet === edit.sheet ? mapIndex(edit, host) : host;
    const span: Span = { start: 0, end: 0 };
    let lossy = false;
    let recompute = false;
    let resized = false;
    let perHost = false;
    const mapped = mapLeaves(tree, (node) => {
        if (node.kind !== NodeKind.Ref) return node;
        const { op, flags, sheetKind } = node;
        const onSheet = sheetOf(node, hostSheet) === edit.sheet;
        if (op === (rows ? RefKind.Columns : RefKind.Rows)) {
            if (onSheet) recompute = true;
            return node;
        }
        const absolute = flags & (rows ? RefFlag.RowAbsolute : RefFlag.ColumnAbsolute);
        const absolute2 = flags & (rows ? RefFlag.Row2Absolute : RefFlag.Column2Absolute);
        const stored = rows ? node.row : node.column;
        const stored2 = rows ? node.row2 : node.column2;
        const target = absolute ? stored : host + stored;
        const target2 = op === RefKind.Cell ? target : absolute2 ? stored2 : host + stored2;
        const inOrder = target <= target2;
        const low = inOrder ? target : target2;
        const high = inOrder ? target2 : target;
        let moved = target;
        let moved2 = target2;
        // A target off the grid reads as #REF! at this host and stays where it is, so that it never comes back.
        if (onSheet && low >= 0 && high < lines) {
            if (!mapSpan(edit, low, high, span)) {
                lossy = true;
                recompute = true;
                return broken(node);
            }
            const lowCut = !edit.insert && low >= index && low < after;
            const highCut = edit.insert ? high >= index && high + count >= lines : high >= index && high < after;
            if (lowCut || highCut) {
                lossy = true;
                recompute = true;
                if ((lowCut && !(inOrder ? absolute : absolute2)) || (highCut && !(inOrder ? absolute2 : absolute))) {
                    perHost = true;
                }
            } else if (!edit.insert && index > low && index < high) {
                recompute = true;
            }
            if (span.end - span.start !== high - low) resized = true;
            moved = inOrder ? span.start : span.end;
            moved2 = inOrder ? span.end : span.start;
        }
        const next = absolute ? moved : moved - hostAfter;
        const next2 = op === RefKind.Cell ? 0 : absolute2 ? moved2 : moved2 - hostAfter;
        if (next === stored && next2 === stored2) return node;
        return rows
            ? referenceNode(op, node.space, sheetKind, node.sheet, next, node.column, next2, node.column2, flags)
            : referenceNode(op, node.space, sheetKind, node.sheet, node.row, next, node.row2, next2, flags);
    });
    return { tree: mapped, lossy, recompute, resized, perHost };
}
