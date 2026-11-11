// The shape table of one workbook: every distinct stored formula text once, under a small integer id that a cell
// holds in place of the text. A shape is the text, its tree, and the facts that need only the tree, computed once
// when it is interned. Equal text is one shape, so a formula filled down ten thousand rows is parsed once.

import { parseStored } from './parser';
import { printStored } from './printer';
import type { FormulaNode } from './tree';
import { NodeKind, SheetKind } from './tree';

export type Shape = {
    readonly text: string;
    // Null for text that does not parse, which is kept as it is.
    readonly tree: FormulaNode | null;
    readonly refs: readonly FormulaNode[];
    // Whether a reference names a sheet that did not exist, so it must be bound when one of that name appears.
    readonly namesSheet: boolean;
};

export class ShapeTable {
    private readonly ids = new Map<string, number>();
    private readonly shapes: Shape[] = [];

    public get size(): number {
        return this.shapes.length;
    }

    // Ids start at 1: in a cell, 0 means no formula.
    public shape(id: number): Shape {
        return this.shapes[id - 1];
    }

    public intern(text: string): number {
        const known = this.ids.get(text);
        if (known !== undefined) return known;
        const parsed = parseStored(text);
        return this.add(text, 'reason' in parsed ? null : parsed);
    }

    // The id of a tree already parsed, such as a formula typed at a cell: its stored text is the key.
    public internTree(tree: FormulaNode): number {
        const text = printStored(tree);
        return this.ids.get(text) ?? this.add(text, tree);
    }

    private add(text: string, tree: FormulaNode | null): number {
        const refs: FormulaNode[] = [];
        const namesSheet = tree !== null && collect(tree, refs);
        this.shapes.push({ text, tree, refs, namesSheet });
        this.ids.set(text, this.shapes.length);
        return this.shapes.length;
    }
}

function collect(node: FormulaNode, refs: FormulaNode[]): boolean {
    if (node.kind === NodeKind.Ref) refs.push(node);
    let namesSheet = node.sheetKind === SheetKind.Name;
    for (const child of node.children) {
        if (collect(child, refs)) namesSheet = true;
    }
    return namesSheet;
}
