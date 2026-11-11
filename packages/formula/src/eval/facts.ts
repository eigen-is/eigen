// What a shape's tree says about every cell that holds it, worked out once when the shape is first met: whether
// this build can evaluate it at all, whether it is volatile or reads cells it does not name, whether its value can
// be more than one cell, and how deep the tree is. They are packed into one number, the depth above the flags.

import type { Registry } from '../functions/registry';
import { FunctionFlag, ParamKind } from '../functions/registry';
import { Token } from '../text/lexer';
import type { FormulaNode } from '../text/tree';
import { NodeKind, RefKind, SheetKind } from '../text/tree';

export const Fact = {
    // A reference into another workbook or across sheets: the cell keeps the value it came with.
    Kept: 1,
    Volatile: 2,
    ReadsUnnamed: 4,
    Array: 8,
} as const;

export const FACT_BITS = 8;

export function shapeFacts(node: FormulaNode, functions: Registry): number {
    if (node.kind === NodeKind.Binary) return chainFacts(node, functions);
    const entry = node.kind === NodeKind.Call ? functions.get(node.text) : undefined;
    let flags = node.sheetKind === SheetKind.External || node.sheetKind === SheetKind.Span ? Fact.Kept : 0;
    let depth = 0;
    for (let i = 0; i < node.children.length; i += 1) {
        let child = shapeFacts(node.children[i], functions);
        depth = Math.max(depth, child >> FACT_BITS);
        // An aggregate takes a range whole, so the range does not make the result an array.
        if (entry !== undefined) {
            const { params, repeat } = entry;
            const param = params[i < params.length ? i : params.length - repeat + ((i - params.length) % repeat)];
            if (param?.kind === ParamKind.Range) child &= ~Fact.Array;
        }
        flags |= child & (Fact.Kept | Fact.Volatile | Fact.ReadsUnnamed | Fact.Array);
    }
    switch (node.kind) {
        case NodeKind.Ref:
            if (node.op !== RefKind.Cell) flags |= Fact.Array;
            break;
        case NodeKind.Array:
            flags |= Fact.Array;
            break;
        case NodeKind.Prefix:
            if (node.op === Token.At) flags &= ~Fact.Array;
            break;
        case NodeKind.Call:
            if (entry === undefined) break;
            if (entry.flags & FunctionFlag.Volatile) flags |= Fact.Volatile;
            if (entry.flags & FunctionFlag.ReadsUnnamed) flags |= Fact.ReadsUnnamed;
            if (entry.flags & FunctionFlag.ReturnsReference) flags |= Fact.Array;
            break;
    }
    return flags | ((depth + 1) << FACT_BITS);
}

// A chain of operators is evaluated in a loop down its left operands, so it is one level deep however long it is,
// and it is read in a loop here too.
function chainFacts(top: FormulaNode, functions: Registry): number {
    let flags = 0;
    let depth = 0;
    let link = top;
    for (; link.kind === NodeKind.Binary; link = link.children[0]) {
        const right = shapeFacts(link.children[1], functions);
        depth = Math.max(depth, right >> FACT_BITS);
        flags |= right & ((1 << FACT_BITS) - 1);
        if (link.op === Token.Colon || link.op === Token.Comma || link.op === Token.Space) flags |= Fact.Array;
        // The box around two references holds cells that neither of them names.
        if (link.op === Token.Colon) flags |= Fact.ReadsUnnamed;
    }
    const first = shapeFacts(link, functions);
    flags |= first & ((1 << FACT_BITS) - 1);
    return flags | ((Math.max(depth, first >> FACT_BITS) + 1) << FACT_BITS);
}
