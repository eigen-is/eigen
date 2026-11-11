// What a formula's stored text becomes when rows or columns are inserted or deleted: each reference keeps naming the
// cells it named, wherever they went. An absolute index goes through the edit's map on the target's sheet, and an
// offset becomes the distance between the mapped target and the mapped host, each on its own sheet. A formula only
// depends on its host through the host's line on the edited axis, so hostClasses cuts a span of host lines into
// stretches with one outcome each and the store transforms a filled column once per stretch, not once per cell.

import type { FormulaNode } from '../text/tree';
import { leaf, NodeKind, RefFlag, RefKind, referenceNode, SheetKind } from '../text/tree';
import { mapLeaves } from './leaves';
import type { Edit, Span } from './map';
import { GONE, mapIndex, mapSpan } from './map';

// Rows or columns inserted or deleted on one sheet, named by its id.
export type LineEdit = Edit & { readonly sheet: string; readonly rows: boolean };

export type Transformed = {
    // The tree that went in when the stored text stays as it is.
    readonly tree: FormulaNode;
    // The old text cannot be derived back from the new: undo must keep it.
    readonly lossy: boolean;
    // The value can change though no cell the formula reads was written: the formula is a seed of the recompute.
    readonly recompute: boolean;
};

// The hosts on the lines `start` to `end`, counted before the edit, which all get this outcome.
export type HostClass = Transformed & { readonly start: number; readonly end: number };

// `host` is the formula's own row for a row edit and its column for a column edit, before the edit. The host
// itself must survive the edit.
export function transformLines(tree: FormulaNode, edit: LineEdit, hostSheet: string, host: number): Transformed {
    const { tree: mapped, lossy, recompute } = shift(tree, edit, hostSheet, host);
    return { tree: mapped, lossy, recompute };
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
    // A class starts where the host, or a target that travels with it, crosses a line the edit treats differently.
    const starts = [from];
    if (hostOnSheet) starts.push(index, second);
    for (const reference of references) {
        const { op, flags, sheetKind } = reference;
        if (op === (rows ? RefKind.Columns : RefKind.Rows)) continue;
        const onSheet =
            sheetKind === SheetKind.Host ? hostOnSheet : sheetKind === SheetKind.Id && reference.sheet === edit.sheet;
        const absolute = rows ? RefFlag.RowAbsolute : RefFlag.ColumnAbsolute;
        if ((flags & absolute) === 0) {
            const offset = rows ? reference.row : reference.column;
            starts.push(-offset, lines - offset);
            if (onSheet) starts.push(index - offset, second - offset);
        }
        if (op !== RefKind.Cell && (flags & (absolute << 2)) === 0) {
            const offset = rows ? reference.row2 : reference.column2;
            starts.push(-offset, lines - offset);
            if (onSheet) starts.push(index - offset, second - offset);
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
            const { tree: mapped, lossy, recompute, perHost } = shift(tree, edit, hostSheet, host);
            const last = perHost ? host : end;
            classes.push({ start: host, end: last, tree: mapped, lossy, recompute });
            host = last + 1;
        }
    }
    return classes;
}

// `perHost` says a range end was clamped to a fixed line and written as an offset, so the next host differs.
function shift(tree: FormulaNode, edit: LineEdit, hostSheet: string, host: number) {
    const { rows, index, count, lines } = edit;
    const hostOnSheet = hostSheet === edit.sheet;
    const hostAfter = hostOnSheet ? mapIndex(edit, host) : host;
    const span: Span = { start: 0, end: 0 };
    let lossy = false;
    let recompute = false;
    let perHost = false;
    const mapped = mapLeaves(tree, (node) => {
        if (node.kind !== NodeKind.Ref) return node;
        const { op, flags, sheetKind } = node;
        const onSheet =
            sheetKind === SheetKind.Host ? hostOnSheet : sheetKind === SheetKind.Id && node.sheet === edit.sheet;
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
        const low = Math.min(target, target2);
        const high = Math.max(target, target2);
        let moved = target;
        let moved2 = target2;
        // A target off the grid reads as #REF! at this host and stays where it is, so that it never comes back.
        if (onSheet && low >= 0 && high < lines) {
            if (!mapSpan(edit, low, high, span)) {
                lossy = true;
                recompute = true;
                return leaf(NodeKind.Error, 0, '#REF!', node.space, sheetKind, node.sheet);
            }
            const after = index + count;
            if (
                edit.insert
                    ? high >= index && high + count >= lines
                    : (low >= index && low < after) || (high >= index && high < after)
            ) {
                lossy = true;
                recompute = true;
                if (!absolute || !absolute2) perHost = true;
            } else if (!edit.insert && index > low && index < high) {
                recompute = true;
            }
            moved = target <= target2 ? span.start : span.end;
            moved2 = target <= target2 ? span.end : span.start;
        }
        const next = absolute ? moved : moved - hostAfter;
        const next2 = op === RefKind.Cell ? 0 : absolute2 ? moved2 : moved2 - hostAfter;
        if (next === stored && next2 === stored2) return node;
        return rows
            ? referenceNode(op, node.space, sheetKind, node.sheet, next, node.column, next2, node.column2, flags)
            : referenceNode(op, node.space, sheetKind, node.sheet, node.row, next, node.row2, next2, flags);
    });
    return { tree: mapped, lossy, recompute, perHost };
}
