// What a shape's tree says about every cell that holds it, worked out from the tree and the function list alone,
// without evaluating: whether this build can evaluate it at all, whether it reads cells it does not name, and how
// deep its evaluation nests. They are packed into one number, the depth above the flags.

import type { Registry } from '../functions/registry';
import { Token } from '../text/lexer';
import type { FormulaNode } from '../text/tree';
import { NodeKind, RefFlag, RefKind, SheetKind } from '../text/tree';
import { ANYWHERE } from './signature';

export const Fact = {
    // A reference into another workbook or across sheets: the cell keeps the value it came with.
    Kept: 1,
    ReadsUnnamed: 4,
} as const;

export const FACT_BITS = 8;
const FLAGS = (1 << FACT_BITS) - 1;

export function shapeFacts(node: FormulaNode, functions: Registry): number {
    let flags = node.sheetKind === SheetKind.External || node.sheetKind === SheetKind.Span ? Fact.Kept : 0;
    let depth = 0;
    // A chain of operators is evaluated in a loop down its left operands, so it is one level deep however long it
    // is, and it is read in a loop here too.
    let link = node;
    for (; link.kind === NodeKind.Binary; link = link.children[0]) {
        const right = shapeFacts(link.children[1], functions);
        depth = Math.max(depth, right >> FACT_BITS);
        flags |= right & FLAGS;
        // The box around two references holds cells that neither of them names.
        if (link.op === Token.Colon) flags |= Fact.ReadsUnnamed;
    }
    if (link !== node) {
        const first = shapeFacts(link, functions);
        return flags | (first & FLAGS) | ((Math.max(depth, first >> FACT_BITS) + 1) << FACT_BITS);
    }
    for (const child of node.children) {
        const facts = shapeFacts(child, functions);
        depth = Math.max(depth, facts >> FACT_BITS);
        flags |= facts & FLAGS;
    }
    const entry = node.kind === NodeKind.Call ? functions.get(node.text) : undefined;
    // An answer that differs from pass to pass, or cells that no argument names, must be computed in every pass.
    if (entry !== undefined && (entry.volatile || entry.returns === ANYWHERE)) flags |= Fact.ReadsUnnamed;
    // A range that takes its size from another names cells of its own only when the two are of one size.
    if (entry !== undefined && entry.sized >= 0 && entry.sized < node.children.length) {
        if (!sameSize(node.children[entry.sized - 2], node.children[entry.sized])) flags |= Fact.ReadsUnnamed;
    }
    return flags | ((depth + 1) << FACT_BITS);
}

// Whether two arguments are references of one size in every cell that holds the formula. Anything else than two
// plain references is taken not to be.
function sameSize(a: FormulaNode, b: FormulaNode): boolean {
    if (a.kind !== NodeKind.Ref || b.kind !== NodeKind.Ref || a.op !== b.op) return false;
    const rows = spanOf(a, true);
    const columns = spanOf(a, false);
    return rows >= 0 && columns >= 0 && rows === spanOf(b, true) && columns === spanOf(b, false);
}

// The rows or columns a reference spans, 0 for all of them, and -1 when it depends on the cell the formula is in.
function spanOf(reference: FormulaNode, rows: boolean): number {
    const { op, flags } = reference;
    if (op === RefKind.Cell) return 1;
    if (op === (rows ? RefKind.Columns : RefKind.Rows)) return 0;
    const fixed = (flags & (rows ? RefFlag.RowAbsolute : RefFlag.ColumnAbsolute)) !== 0;
    const fixed2 = (flags & (rows ? RefFlag.Row2Absolute : RefFlag.Column2Absolute)) !== 0;
    if (fixed !== fixed2) return -1;
    return Math.abs(rows ? reference.row2 - reference.row : reference.column2 - reference.column) + 1;
}
