// What every transform of formula text shares. The walk: a tree goes in, each node without children is offered to
// the caller, and a tree comes out that is the same object where nothing changed and shares every untouched branch;
// the row and column transform, the move and the sheet rewrites are each one function over a leaf on top of it. And
// the questions they ask of a reference leaf, such as which sheet it reads and whether it fell off the grid.

import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import type { FormulaNode } from '../text/tree';
import { branch, leaf, NodeKind, RefFlag, SheetKind } from '../text/tree';

export function mapLeaves(node: FormulaNode, map: (leaf: FormulaNode) => FormulaNode): FormulaNode {
    const { children } = node;
    if (children.length === 0) return map(node);
    let mapped: FormulaNode[] | null = null;
    for (let i = 0; i < children.length; i += 1) {
        const child = mapLeaves(children[i], map);
        if (child === children[i]) continue;
        mapped ??= children.slice();
        mapped[i] = child;
    }
    return mapped ? branch(node.kind, node.op, node.text, mapped, node.space, node.spaceEnd) : node;
}

// What a reference becomes when the cells it named are gone: #REF! in its place, on the sheet it named.
export function broken(reference: FormulaNode): FormulaNode {
    return leaf(NodeKind.Error, 0, '#REF!', reference.space, reference.sheetKind, reference.sheet);
}

// The id of the sheet a reference reads from a host on `hostSheet`, or null when it names no sheet of this workbook.
export function sheetOf(reference: FormulaNode, hostSheet: string): string | null {
    if (reference.sheetKind === SheetKind.Host) return hostSheet;
    return reference.sheetKind === SheetKind.Id ? reference.sheet : null;
}

// Whether a reference names cells off the grid at this host, where it reads as #REF!. A copy, a fill and a sort keep
// the stored text, so this check is all they need. The part a whole column or row lacks resolves to the host's own.
export function offGrid(reference: FormulaNode, hostRow: number, hostColumn: number): boolean {
    const { flags } = reference;
    const row = flags & RefFlag.RowAbsolute ? reference.row : hostRow + reference.row;
    const column = flags & RefFlag.ColumnAbsolute ? reference.column : hostColumn + reference.column;
    const row2 = flags & RefFlag.Row2Absolute ? reference.row2 : hostRow + reference.row2;
    const column2 = flags & RefFlag.Column2Absolute ? reference.column2 : hostColumn + reference.column2;
    if (Math.min(row, row2, column, column2) < 0) return true;
    return Math.max(row, row2) >= GRID_ROWS || Math.max(column, column2) >= GRID_COLUMNS;
}
