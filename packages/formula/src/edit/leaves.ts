// What every transform of formula text shares. The walk: a tree goes in, each node without children is offered to
// the caller, and a tree comes out that is the same object where nothing changed and shares every untouched branch;
// the row and column transform, the move and the sheet rewrites are each one function over a leaf on top of it. And
// the questions they ask of a reference leaf, such as which sheet it reads and whether it fell off the grid.

import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import { REF_ERROR } from '../text/lexer';
import type { Ends, FormulaNode } from '../text/tree';
import { branch, endsAt, leaf, NodeKind, SheetKind } from '../text/tree';

export function mapLeaves(node: FormulaNode, map: (leaf: FormulaNode) => FormulaNode): FormulaNode {
    const { children } = node;
    if (children.length === 0) return map(node);
    if (node.kind === NodeKind.Binary) {
        // A long sum is a chain too deep to recurse down its left operands, so it is rebuilt from its far end up.
        const chain: FormulaNode[] = [];
        let first = node;
        for (; first.kind === NodeKind.Binary; first = first.children[0]) chain.push(first);
        let left = mapLeaves(first, map);
        for (let i = chain.length - 1; i >= 0; i -= 1) {
            const link = chain[i];
            const right = mapLeaves(link.children[1], map);
            const same = left === link.children[0] && right === link.children[1];
            left = same
                ? link
                : branch(link.kind, link.op, link.text, [left, right], link.space, link.spaceOpen, link.spaceEnd);
        }
        return left;
    }
    let mapped: FormulaNode[] | null = null;
    for (let i = 0; i < children.length; i += 1) {
        const child = mapLeaves(children[i], map);
        if (child === children[i]) continue;
        mapped ??= children.slice();
        mapped[i] = child;
    }
    return mapped ? branch(node.kind, node.op, node.text, mapped, node.space, node.spaceOpen, node.spaceEnd) : node;
}

// What a reference becomes when the cells it named are gone: #REF! in its place, on the sheet it named.
export function broken(reference: FormulaNode): FormulaNode {
    return leaf(NodeKind.Error, REF_ERROR, '', reference.space, reference.sheetKind, reference.sheet);
}

// The id of the sheet a reference reads from a host on `hostSheet`, or null when it names no sheet of this workbook.
export function sheetOf(reference: FormulaNode, hostSheet: string): string | null {
    if (reference.sheetKind === SheetKind.Host) return hostSheet;
    return reference.sheetKind === SheetKind.Id ? reference.sheet : null;
}

// Whether a reference names cells off the grid at this host, where it reads as #REF!. A copy, a fill and a sort keep
// the stored text, so this check is all they need.
export function offGrid(reference: FormulaNode, hostRow: number, hostColumn: number): boolean {
    const ends: Ends = { first: 0, second: 0 };
    return (
        !endsAt(reference, true, hostRow, GRID_ROWS, ends) || !endsAt(reference, false, hostColumn, GRID_COLUMNS, ends)
    );
}
