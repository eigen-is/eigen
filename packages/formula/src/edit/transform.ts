// What a formula's stored text becomes when rows or columns are inserted or deleted: each reference keeps naming the
// cells it named, wherever they went. An absolute index goes through the edit's map on the target's sheet, and an
// offset becomes the distance between the mapped target and the mapped host, each on its own sheet. A formula only
// depends on its host through the host's line on the edited axis, so hostClasses cuts a span of host lines into
// stretches with one outcome each: a filled column is transformed once per stretch, not once per cell.

import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import type { Ends, FormulaNode } from '../text/tree';
import { endsAt, NodeKind, RefFlag, RefKind, referenceNode } from '../text/tree';
import { broken, mapLeaves, sheetOf } from './leaves';
import type { Edit, Span } from './map';
import { firstPushed, GONE, mapIndex, mapSpan } from './map';

// `count` rows or columns inserted so that the first new one is line `index`, or the `count` from `index` on deleted,
// on the sheet of this id.
export type LineEdit = {
    readonly insert: boolean;
    readonly index: number;
    readonly count: number;
    readonly sheet: string;
    readonly rows: boolean;
};

export type Transformed = {
    // The tree that went in when the stored text stays as it is.
    readonly tree: FormulaNode;
    // The old text cannot be derived back from the new: undo must keep it.
    readonly lossy: boolean;
    // A cell a reference named is gone: the value can change whatever the formula computes, so it is a seed of the
    // recompute.
    readonly recompute: boolean;
    // A range that is still a range spans another number of lines than it did, and every cell it reads kept its
    // value: a seed only for a formula that depends on the size of a range, which its shape's facts say.
    readonly resized: boolean;
    // A whole column or row a reference names lies along the edited lines of the edited sheet: the value changes
    // only when a cell of it sat at or past the edit, which the store knows and the tree does not.
    readonly slid: boolean;
};

// The hosts on the lines `start` to `end`, counted before the edit, which all get this outcome.
type HostClass = Transformed & { readonly start: number; readonly end: number };

// `host` is the formula's own row for a row edit and its column for a column edit, before the edit. The host
// itself must survive the edit.
export function transformLines(tree: FormulaNode, edit: LineEdit, hostSheet: string, host: number): Transformed {
    return shift(tree, edit, onAxis(edit), hostSheet, host).result;
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
    const { rows, index } = edit;
    const axis = onAxis(edit);
    const { lines } = axis;
    const second = edit.insert ? firstPushed(index, edit.count, lines) : index + edit.count;
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
        if (hostOnSheet && mapIndex(axis, start) === GONE) continue;
        const end = i + 1 < starts.length ? Math.min(to, starts[i + 1] - 1) : to;
        for (let host = start; host <= end; ) {
            const { result, perHost } = shift(tree, edit, axis, hostSheet, host);
            const last = perHost ? host : end;
            classes.push({ start: host, end: last, ...result });
            host = last + 1;
        }
    }
    return classes;
}

// The edit as the maps take it, on the axis it edits.
function onAxis({ insert, index, count, rows }: LineEdit): Edit {
    return { insert, index, count, lines: rows ? GRID_ROWS : GRID_COLUMNS };
}

// `perHost` says an end that travels with the host was cut off at a fixed line, so the next host differs.
function shift(
    tree: FormulaNode,
    edit: LineEdit,
    axis: Edit,
    hostSheet: string,
    host: number,
): { result: Transformed; perHost: boolean } {
    const { rows } = edit;
    const { index, count, lines } = axis;
    const after = index + count;
    const hostAfter = hostSheet === edit.sheet ? mapIndex(axis, host) : host;
    const ends: Ends = { first: 0, second: 0 };
    const span: Span = { start: 0, end: 0 };
    let lossy = false;
    let recompute = false;
    let resized = false;
    let slid = false;
    let perHost = false;
    const mapped = mapLeaves(tree, (node) => {
        if (node.kind !== NodeKind.Ref) return node;
        const { op, flags, sheetKind } = node;
        const onSheet = sheetOf(node, hostSheet) === edit.sheet;
        if (op === (rows ? RefKind.Columns : RefKind.Rows)) {
            if (onSheet) slid = true;
            return node;
        }
        const absolute = flags & (rows ? RefFlag.RowAbsolute : RefFlag.ColumnAbsolute);
        const absolute2 = flags & (rows ? RefFlag.Row2Absolute : RefFlag.Column2Absolute);
        const stored = rows ? node.row : node.column;
        const stored2 = rows ? node.row2 : node.column2;
        const onGrid = endsAt(node, rows, host, lines, ends);
        const target = ends.first;
        const target2 = ends.second;
        const inOrder = target <= target2;
        const low = inOrder ? target : target2;
        const high = inOrder ? target2 : target;
        let moved = target;
        let moved2 = target2;
        // A target off the grid reads as #REF! at this host and stays where it is, so that it never comes back.
        if (onSheet && onGrid) {
            if (!mapSpan(axis, low, high, span)) {
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
    return { result: { tree: mapped, lossy, recompute, resized, slid }, perHost };
}
