// The shape table of one workbook: every distinct stored formula text once, under a small integer id that a cell
// holds in place of the text. A shape is the text, its tree, and the facts that need only the tree, computed once
// when it is interned. Equal text is one shape, so a formula filled down ten thousand rows is parsed once. A shape
// no cell holds any more is forgotten when the holder of the cells says which are held, and its id is given out
// again: so an id means one shape only for as long as a cell holds it. The table stays as long as the most shapes
// it ever held: a freed slot is used again, and the list never shrinks.

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

// What the slot of a forgotten shape holds until a new shape takes it.
const FORGOTTEN: Shape = { text: '', tree: null, refs: [], namesSheet: false };

export class ShapeTable {
    private readonly ids = new Map<string, number>();
    private readonly shapes: Shape[] = [];
    // The ids of the forgotten shapes, each for the next new shape.
    private readonly free: number[] = [];
    // Per id, what the recalc worked out of the shape's tree and its functions, or -1 until it has. The list is
    // kept here because it is here that an id goes to another shape, which starts with nothing.
    public readonly facts: number[] = [-1];

    // The highest id given out so far.
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

    // Forgets every shape whose id is not set in `held`, which says for each id up to `size` whether a cell holds
    // it. The id of a shape that stays does not change.
    public keep(held: Uint8Array): void {
        for (let id = 1; id <= this.shapes.length; id += 1) {
            const shape = this.shapes[id - 1];
            if (held[id] !== 0 || shape === FORGOTTEN) continue;
            this.ids.delete(shape.text);
            this.shapes[id - 1] = FORGOTTEN;
            this.free.push(id);
        }
    }

    private add(text: string, tree: FormulaNode | null): number {
        const refs: FormulaNode[] = [];
        const namesSheet = tree !== null && collect(tree, refs);
        const id = this.free.pop() ?? this.shapes.length + 1;
        this.shapes[id - 1] = { text, tree, refs, namesSheet };
        this.facts[id] = -1;
        this.ids.set(text, id);
        return id;
    }
}

// A sum of thousands of terms is a chain that deep down its left operands, so that side is read in a loop.
function collect(node: FormulaNode, refs: FormulaNode[]): boolean {
    const rights: FormulaNode[] = [];
    let first = node;
    for (; first.kind === NodeKind.Binary; first = first.children[0]) rights.push(first.children[1]);
    if (first.kind === NodeKind.Ref) refs.push(first);
    let namesSheet = first.sheetKind === SheetKind.Name;
    for (const child of first.children) {
        if (collect(child, refs)) namesSheet = true;
    }
    for (let i = rights.length - 1; i >= 0; i -= 1) {
        if (collect(rights[i], refs)) namesSheet = true;
    }
    return namesSheet;
}
