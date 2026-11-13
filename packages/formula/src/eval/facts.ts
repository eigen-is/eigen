// What a shape's tree says about every cell that holds it, worked out from the tree and the function list alone,
// without evaluating: whether this build can evaluate it at all, whether it reads cells it does not name,
// whether a structural edit can change its answer through a place or a size, and how much of the stack its
// evaluation can take. They are packed into one number, the depth above the flags.

import type { Registry } from '../functions/registry';
import { CellKind } from '../store/column';
import { Token } from '../text/lexer';
import type { FormulaNode } from '../text/tree';
import { NodeKind, RefFlag, RefKind, SheetKind } from '../text/tree';
import type { Param } from './signature';
import { ANYWHERE, Read, slotOf } from './signature';

export const Fact = {
    // A reference into another workbook or across sheets: the cell keeps the value it came with.
    Kept: 1,
    // A call of a row that picks another row, such as SUBTOTAL: an outer such call passes the cell over.
    Chosen: 2,
    // Cells that the tree does not name may be read, so a write anywhere can change the answer.
    ReadsUnnamed: 4,
    // The answer depends on where the cell or a cell it names sits: a call of a row that reads a place, as ROW
    // does, or the @ in front of a range. Moving the cell or rewriting its references can change it.
    Positional: 8,
    // The answer can depend on how many lines a range spans: a range stands somewhere else than as the argument
    // of a parameter that passes over empty cells.
    Sized: 16,
} as const;

export const FACT_BITS = 8;
const FLAGS = (1 << FACT_BITS) - 1;

// What one level of nesting takes of the stack, in units of the calls a pair of brackets takes. A call counts as
// one that runs once per element and picks its argument, the deepest a call gets.
const BRACKETS = 1;
const SIGN = 3;
const OPERATOR = 5;
const CALL = 8;
// A call that reads cells from inside its body, and a range that is read as an array, on top of reading one cell.
const READING = 12;
const RANGE = 3;

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
        return flags | (first & FLAGS) | ((Math.max(depth, first >> FACT_BITS) + OPERATOR) << FACT_BITS);
    }
    const entry = node.kind === NodeKind.Call ? functions.get(node.text) : undefined;
    const { children } = node;
    for (let i = 0; i < children.length; i += 1) {
        let facts = shapeFacts(children[i], functions);
        // A range read by a family that counts no empty cell gives the same answer with more or fewer of them.
        // A call of a wrong number of arguments has no record for some of them.
        const slot: Param<unknown> | undefined =
            entry !== undefined && children[i].kind === NodeKind.Ref ? slotOf(entry, i, children.length) : undefined;
        const family = slot?.family ?? null;
        if (family !== null && (family.kinds & (1 << CellKind.Empty)) === 0) facts &= ~Fact.Sized;
        depth = Math.max(depth, facts >> FACT_BITS);
        flags |= facts & FLAGS;
    }
    if (entry?.slots.some((slot) => slot.read === Read.Here)) flags |= Fact.Positional;
    if (node.kind === NodeKind.Prefix && node.op === Token.At) flags |= Fact.Positional;
    if (entry !== undefined && entry.chosen !== null) flags |= Fact.Chosen;
    if (entry?.returns === ANYWHERE) flags |= Fact.ReadsUnnamed;
    // What a row asks of the workbook itself, such as the text of a formula, is the value of no cell it names.
    if (entry?.params.some((param) => param.read === Read.Engine)) flags |= Fact.ReadsUnnamed;
    // A range that takes its size from another names cells of its own only when the two are of one size.
    if (entry !== undefined && entry.matched > entry.where && entry.matched < node.children.length) {
        if (!sameSize(node.children[entry.where], node.children[entry.matched])) flags |= Fact.ReadsUnnamed;
    }
    if (node.kind === NodeKind.Call) depth = Math.max(READING, depth + CALL);
    else if (node.kind === NodeKind.Prefix || node.kind === NodeKind.Postfix) depth += SIGN;
    else if (node.kind === NodeKind.Paren || node.kind === NodeKind.Invoke) depth += BRACKETS;
    else if (node.kind === NodeKind.Ref && node.op !== RefKind.Cell) {
        depth = RANGE;
        flags |= Fact.Sized;
    }
    return flags | (depth << FACT_BITS);
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
