// The xlsx dialect: a formula as a file spells it, read into the one tree and written back. Reading is the A1 parser
// and a walk that takes the file's spellings out, such as _xlfn.SINGLE(x) for @x; writing is the walk back and then
// printXlsx. intersect puts the @ where an Excel without dynamic arrays read one cell of a range: an importer calls
// it for a plain cell only, and a function the engine lacks that day stays without its @ for good, the one loss.
// isLegacy says how to write a cell: true is a plain formula, false an array formula with the dynamic-array mark.

import type { Param } from '../eval/signature';
import { ANYWHERE, PART, Prepare, Read, slotOf } from '../eval/signature';
import {
    EXCEL_2007_FUNCTIONS,
    EXCEL_ARRAY_FUNCTIONS,
    EXCEL_FUTURE_FUNCTIONS,
    EXCEL_WORKSHEET_FUNCTIONS,
} from '../functions/excel-names';
import type { Registry } from '../functions/registry';
import { columnIndex } from './a1';
import { UNDERSCORE } from './chars';
import { REF_ERROR, Token } from './lexer';
import type { ParseFailure, SheetFinder } from './parser';
import { bounded, parseA1, readsAsReference } from './parser';
import { isTableCell } from './tables';
import type { FormulaNode } from './tree';
import { branch, leaf, NodeKind, RefFlag, RefKind, referenceNode, SheetKind } from './tree';

// What a place reads its node as: one value, a reference as it stands, an array, or, where the function list cannot
// tell, more than one of these. TOP is the cell's own value, with no call around it: only there is an array cut.
const ONE = 1;
const PLACE = 2;
const ARRAY = 4;
const TOP = 8;
const CLASS = ONE | PLACE | ARRAY;

const PARAMETER = '_xlpm.';
const OPTIONAL = '_xlop.';
// The marks of a function that is no one's built-in, such as _XLUDF. and _XLL., as a stored call spells them.
const FOREIGN = /^(?:_+XL[A-Z]+\.)+/;
const NO_NAMES: readonly string[] = [];

// The text of a file's <f> at its cell, row and column from 0, as a tree in the engine's own spellings.
export function parseXlsx(
    text: string,
    hostRow: number,
    hostColumn: number,
    findSheet: SheetFinder,
): FormulaNode | ParseFailure {
    const tree = parseA1(text, hostRow, hostColumn, findSheet);
    return 'reason' in tree ? tree : bounded(spellIn(tree));
}

// The tree of a plain <f> with an @ wherever an Excel without dynamic arrays read one cell of what may be many.
// An @ is a level of nesting, so a tree at the limit can come back as a failure.
export function intersect(tree: FormulaNode, functions: Registry): FormulaNode | ParseFailure {
    return bounded(cut(tree, functions, ONE | TOP));
}

// Whether a plain <f> gives the cell the value it has here: no place that certainly or possibly wants one value
// holds what may be many cells without an @. A formula with LET or LAMBDA never is, as no such Excel has them.
export function isLegacy(tree: FormulaNode, functions: Registry): boolean {
    return settled(tree, functions, ONE | TOP);
}

// The tree in a file's spellings, for printXlsx. With `legacy`, as isLegacy answered for it, the @ that intersect
// would put back are left out; every other @ is a call of SINGLE.
export function xlsxTree(tree: FormulaNode, functions: Registry, legacy: boolean): FormulaNode {
    return spellOut(tree, functions, legacy, ONE | TOP, NO_NAMES);
}

// The four walks below read a chain of operators in a loop down its left operands: a sum of thousands of terms is
// that deep, and each walk does something else per link, so the loop is written out in each.
function spellIn(node: FormulaNode): FormulaNode {
    const { kind, children, text } = node;
    if (kind === NodeKind.Name) {
        if (node.sheetKind !== SheetKind.Host || !marks(text, PARAMETER)) return node;
        // The bare name is what the A1 reader makes of it: one that reads as a cell or a boolean keeps its prefix.
        const bare = parseA1(text.slice(PARAMETER.length), 0, 0, () => undefined);
        const named = !('reason' in bare) && bare.kind === NodeKind.Name;
        return named ? leaf(kind, 0, bare.text, node.space, SheetKind.Host, '') : node;
    }
    if (kind === NodeKind.Binary) {
        const links: FormulaNode[] = [];
        let first = node;
        for (; first.kind === NodeKind.Binary; first = first.children[0]) links.push(first);
        let left = childIn(links[links.length - 1], 0);
        for (let i = links.length - 1; i >= 0; i -= 1) {
            const link = links[i];
            let right = childIn(link, 1);
            // Two bare names around a colon, or one before a column, read as columns, so a parameter there is
            // bracketed. So is a name before the brackets this walk made: with whitespace between, that reads as a call.
            if (link.op === Token.Colon && (left !== link.children[0] || right !== link.children[1])) {
                if (readsAsColumns(left, right)) {
                    if (right.kind === NodeKind.Name) right = fence(right);
                    else left = fence(left);
                }
            }
            if (link.op === Token.Space && leftmost(right).kind === NodeKind.Paren && right !== link.children[1]) {
                let last = left;
                while (last.kind === NodeKind.Binary) [, last] = last.children;
                if (last.kind === NodeKind.Name && last.sheetKind === SheetKind.Host) left = fence(left);
            }
            left = left === link.children[0] && right === link.children[1] ? link : remade(link, [left, right]);
        }
        return left;
    }
    let next: FormulaNode[] | null = null;
    for (let i = 0; i < children.length; i += 1) {
        const child = childIn(node, i);
        if (child !== children[i]) (next ??= children.slice())[i] = child;
    }
    if (kind !== NodeKind.Call) return next === null ? node : remade(node, next);
    let name = text;
    if (text.charCodeAt(0) === UNDERSCORE) {
        const worksheet = text.startsWith('_XLFN._XLWS.');
        const bare = text.slice(worksheet ? 12 : 6);
        const known = worksheet ? EXCEL_WORKSHEET_FUNCTIONS : EXCEL_FUTURE_FUNCTIONS;
        // A called name spelled like a function of Excel's is that function to Excel, bound or not, so only
        // another name is a called parameter: one that prints as itself, not as a cell.
        const parameter = text.startsWith('_XLPM.') && bare !== '' && !isExcel(bare) && !readsAsReference(bare);
        if (parameter || (text.startsWith('_XLFN.') && known.has(bare))) name = bare;
    }
    const [child] = next ?? children;
    if (children.length !== 1 || (name !== 'SINGLE' && name !== 'ANCHORARRAY')) {
        return next === null && name === text ? node : remade(node, next ?? children, name);
    }
    // SINGLE and ANCHORARRAY are the @ and the # they stand for, with brackets around an argument that binds
    // looser than the operator does.
    if (name === 'SINGLE') {
        const loose =
            child.kind === NodeKind.Binary
                ? child.op !== Token.Colon && child.op !== Token.Space
                : child.kind === NodeKind.Postfix && child.op === Token.Percent;
        return branch(NodeKind.Prefix, Token.At, '', [loose ? bracketed(child) : child], node.space, '', '');
    }
    const anchors =
        child.kind === NodeKind.Ref ||
        child.kind === NodeKind.Name ||
        child.kind === NodeKind.Call ||
        child.kind === NodeKind.Invoke ||
        child.kind === NodeKind.Paren ||
        (child.kind === NodeKind.Postfix && child.op === Token.Hash) ||
        (child.kind === NodeKind.Error && child.value === REF_ERROR);
    // The whitespace before the call is the anchor's: a # has no place for what stood inside the brackets.
    const anchor = indent(anchors ? child : bracketed(child), node.space);
    return branch(NodeKind.Postfix, Token.Hash, '', [anchor], '', '', '');
}

// One child on the way in. A file's SINGLE or ANCHORARRAY binds as a call does, so the @ or # it became gets
// brackets where its parent binds tighter than it.
function childIn(parent: FormulaNode, at: number): FormulaNode {
    const child = parent.children[at];
    const spelled = spellIn(child);
    const tight = child.kind === NodeKind.Call && isAtOrHash(spelled) && fenced(parent, at, spelled);
    return tight ? fence(spelled) : spelled;
}

// Whether a colon between these two operands, printed bare, reads as columns: a name that is a column label, then
// another such name or a whole column.
function readsAsColumns(left: FormulaNode, right: FormulaNode): boolean {
    const before = left.kind === NodeKind.Binary ? left.children[1] : left;
    let after = right;
    while (after.kind === NodeKind.Postfix || after.kind === NodeKind.Invoke) [after] = after.children;
    if (before.kind !== NodeKind.Name || columnIndex(before.text) === -1 || after.space !== '') return false;
    if (after.kind === NodeKind.Ref) return after.op === RefKind.Columns;
    return (after.kind === NodeKind.Name || after.spaceOpen !== '') && columnIndex(after.text) !== -1;
}

// The node in brackets, with the whitespace before it moved in front of them.
function fence(node: FormulaNode): FormulaNode {
    return indent(bracketed(indent(node, '')), leading(node));
}

function isAtOrHash(node: FormulaNode): boolean {
    return (
        (node.kind === NodeKind.Prefix && node.op === Token.At) ||
        (node.kind === NodeKind.Postfix && node.op === Token.Hash)
    );
}

// Whether an @ or a # needs brackets as child `at` of this parent, to print as the tree it is.
function fenced(parent: FormulaNode, at: number, child: FormulaNode): boolean {
    if (parent.kind === NodeKind.Invoke) return at === 0;
    if (child.op === Token.Hash) {
        // A cell, a colon and a cell read as one range, so the # after them would anchor that range.
        if (parent.kind !== NodeKind.Binary || parent.op !== Token.Colon || at === 0) return false;
        const [left] = parent.children;
        const before = left.kind === NodeKind.Binary ? left.children[1] : left;
        let after = child;
        while (after.kind === NodeKind.Postfix || after.kind === NodeKind.Invoke) [after] = after.children;
        return before.kind === NodeKind.Ref && before.op === RefKind.Cell && after.kind === NodeKind.Ref;
    }
    return parent.kind === NodeKind.Binary ? joins(parent.op) : parent.kind === NodeKind.Postfix && isAtOrHash(parent);
}

function cut(node: FormulaNode, functions: Registry, context: number): FormulaNode {
    // What gets an @ is read as a place under it, so its own @ is decided before anything inside it.
    if (wanted(node, functions, context)) return single(cut(node, functions, PLACE));
    let out = node;
    if (node.kind === NodeKind.Binary) {
        const links: FormulaNode[] = [];
        const inners: number[] = [];
        let first = node;
        let inner = context;
        for (; first.kind === NodeKind.Binary; first = first.children[0]) {
            inner = contextOf(first, 0, inner, functions);
            links.push(first);
            inners.push(inner);
        }
        out = cut(first, functions, inner);
        for (let i = links.length - 1; i >= 0; i -= 1) {
            const link = links[i];
            const right = cut(link.children[1], functions, inners[i]);
            out = out === link.children[0] && right === link.children[1] ? link : remade(link, [out, right]);
            if (i > 0 && wanted(out, functions, inners[i - 1])) out = single(out);
        }
    } else if (!binds(node)) {
        const { children } = node;
        let next: FormulaNode[] | null = null;
        for (let i = 0; i < children.length; i += 1) {
            const child = cut(children[i], functions, contextOf(node, i, context, functions));
            if (child !== children[i]) (next ??= children.slice())[i] = child;
        }
        if (next !== null) out = remade(node, next);
    }
    return out;
}

function single(node: FormulaNode): FormulaNode {
    return branch(NodeKind.Prefix, Token.At, '', [indent(node, '')], leading(node), '', '');
}

function settled(node: FormulaNode, functions: Registry, context: number): boolean {
    let last = node;
    let inner = context;
    for (; ; last = last.children[0]) {
        if (loose(last, functions, inner)) return false;
        if (last.kind !== NodeKind.Binary) break;
        inner = contextOf(last, 0, inner, functions);
        if (!settled(last.children[1], functions, inner)) return false;
    }
    if (binds(last)) return false;
    const { children } = last;
    for (let i = 0; i < children.length; i += 1) {
        if (!settled(children[i], functions, contextOf(last, i, inner, functions))) return false;
    }
    return true;
}

function spellOut(
    node: FormulaNode,
    functions: Registry,
    legacy: boolean,
    context: number,
    bound: readonly string[],
): FormulaNode {
    const { kind, children, text } = node;
    if (kind === NodeKind.Name) {
        const host = node.sheetKind === SheetKind.Host && bound.length > 0;
        const own = host ? declared(bound, text.toUpperCase()) : undefined;
        return own === undefined ? node : leaf(kind, 0, PARAMETER + own, node.space, SheetKind.Host, '');
    }
    if (kind === NodeKind.Binary) {
        const links: FormulaNode[] = [];
        const outers: number[] = [];
        let first = node;
        let outer = context;
        for (; first.kind === NodeKind.Binary; first = first.children[0]) {
            links.push(first);
            outers.push(outer);
            outer = contextOf(first, 0, outer, functions);
        }
        const deepest = links.length - 1;
        let left = childOut(links[deepest], 0, functions, legacy, outers[deepest], bound);
        for (let i = deepest; i >= 0; i -= 1) {
            const link = links[i];
            const right = childOut(link, 1, functions, legacy, outers[i], bound);
            left = left === link.children[0] && right === link.children[1] ? link : remade(link, [left, right]);
        }
        return left;
    }
    const lambda = kind === NodeKind.Call && text === 'LAMBDA';
    const binder = lambda || (kind === NodeKind.Call && text === 'LET');
    let scope = bound;
    let wider = bound;
    let next: FormulaNode[] | null = null;
    for (let i = 0; i < children.length; i += 1) {
        const name = children[i];
        const place = binder && i < children.length - 1 && (lambda || i % 2 === 0);
        const declares = place && name.kind === NodeKind.Name && !marks(name.text, PARAMETER);
        if (declares) wider = [...scope, marks(name.text, OPTIONAL) ? name.text.slice(OPTIONAL.length) : name.text];
        // A name of LET is bound from the pair after its own, so its value still reads the name outside.
        if (lambda) scope = wider;
        const child = childOut(node, i, functions, legacy, context, declares ? wider : scope);
        if (!declares) scope = wider;
        if (child !== name) (next ??= children.slice())[i] = child;
    }
    if (isAtOrHash(node)) {
        const [child] = next ?? children;
        if (node.op === Token.Hash) return call('_xlfn.ANCHORARRAY', indent(child, ''), leading(child));
        if (legacy && wanted(children[0], functions, context)) return indent(child, node.space + leading(child));
        return call('_xlfn.SINGLE', isUnion(child) ? bracketed(child) : child, node.space);
    }
    if (kind !== NodeKind.Call) return next === null ? node : remade(node, next);
    const own = isExcel(text) ? undefined : declared(bound, text);
    let name = text;
    if (own !== undefined) name = PARAMETER + own;
    else if (EXCEL_WORKSHEET_FUNCTIONS.has(text)) name = `_xlfn._xlws.${text}`;
    else if (EXCEL_FUTURE_FUNCTIONS.has(text)) name = `_xlfn.${text}`;
    else if (text.charCodeAt(0) === UNDERSCORE) name = text.replace(FOREIGN, (prefix) => prefix.toLowerCase());
    return next === null && name === text ? node : remade(node, next ?? children, name);
}

// One child on the way out: the brackets that childIn put around an @ or a # go again.
function childOut(
    parent: FormulaNode,
    at: number,
    functions: Registry,
    legacy: boolean,
    context: number,
    bound: readonly string[],
): FormulaNode {
    const child = parent.children[at];
    const inner = child.kind === NodeKind.Paren ? child.children[0] : child;
    const colon = parent.kind === NodeKind.Binary && parent.op === Token.Colon && inner.kind === NodeKind.Name;
    const [left, right] = parent.children;
    const bare =
        inner !== child &&
        (colon
            ? readsAsColumns(at === 0 ? inner : left, at === 1 ? inner : right)
            : isAtOrHash(inner) && fenced(parent, at, inner));
    const spelled = spellOut(bare ? inner : child, functions, legacy, contextOf(parent, at, context, functions), bound);
    return bare && spelled !== inner ? indent(spelled, child.space) : bare ? child : spelled;
}

// The spelling a parameter was declared with, by its name in upper case.
function declared(bound: readonly string[], name: string): string | undefined {
    for (let i = bound.length - 1; i >= 0; i -= 1) {
        if (bound[i].toUpperCase() === name) return bound[i];
    }
    return undefined;
}

// What child `at` of a parent is read as, when the parent itself is read as `context`.
function contextOf(parent: FormulaNode, at: number, context: number, functions: Registry): number {
    switch (parent.kind) {
        case NodeKind.Paren:
            return context;
        case NodeKind.Prefix:
        case NodeKind.Postfix:
            return isAtOrHash(parent) ? PLACE : operand(context);
        case NodeKind.Binary:
            return joins(parent.op) ? PLACE : operand(context);
        case NodeKind.Call: {
            const entry = functions.get(parent.text);
            // A call of a wrong number of arguments has no record for some of them, and a function the engine
            // lacks has none at all: such an argument is taken as it stands.
            const slot: Param<unknown> | undefined = entry && slotOf(entry, at, parent.children.length);
            if (entry === undefined || slot === undefined) return PLACE;
            if (slot.prepare === Prepare.Lazy || slot.read === Read.Walked || slot.read === Read.Texts) return PLACE;
            if (slot.read === Read.Products || slot.read === Read.Table) return slot.placed ? PLACE : ARRAY;
            // What takes whatever was written, as TYPE does, is read in a way no record says: any of the three.
            if (slot.read === Read.Anything) return CLASS;
            if (slot.prepare !== Prepare.Scalar && slot.prepare !== Prepare.Single) return PLACE | ARRAY;
            // An array ends at a call that picks an argument, as IF does: its test is one value again.
            return entry.slots.some((other) => other.prepare === Prepare.Lazy) ? ONE : operand(context) & CLASS;
        }
        default:
            return PLACE;
    }
}

// What an operator makes of its operands, and a value parameter of its argument: one value, unless an array is read.
function operand(context: number): number {
    return (context & (ARRAY | TOP)) | ((context & (ONE | PLACE)) !== 0 ? ONE : 0);
}

function isExcel(name: string): boolean {
    return EXCEL_FUTURE_FUNCTIONS.has(name) || EXCEL_2007_FUNCTIONS.has(name);
}

function marks(name: string, prefix: string): boolean {
    return name.charCodeAt(0) === UNDERSCORE && name.slice(0, prefix.length).toLowerCase() === prefix;
}

function joins(op: number): boolean {
    return op === Token.Colon || op === Token.Space || op === Token.Comma;
}

function binds(node: FormulaNode): boolean {
    return node.kind === NodeKind.Call && (node.text === 'LET' || node.text === 'LAMBDA');
}

// Whether an @ belongs on a node read as `context`: one value is certain, and the node may be many cells.
function wanted(node: FormulaNode, functions: Registry, context: number): boolean {
    return (context & CLASS) === ONE && loose(node, functions, context);
}

// Whether a node may be many cells where one value may be wanted. Brackets leave that to what they hold, so an @
// stands inside them, but for a union, which is one thing with its brackets.
function loose(node: FormulaNode, functions: Registry, context: number): boolean {
    if ((context & ONE) === 0 || (node.kind === NodeKind.Paren && !isUnion(node.children[0]))) return false;
    return many(node, functions, (context & TOP) !== 0);
}

function isUnion(node: FormulaNode): boolean {
    return node.kind === NodeKind.Binary && node.op === Token.Comma;
}

// Whether a node may be more than one cell. A name never is: an importer puts a name's range in its place first.
function many(node: FormulaNode, functions: Registry, top: boolean): boolean {
    switch (node.kind) {
        case NodeKind.Ref:
            return node.op !== RefKind.Cell;
        case NodeKind.Table:
            return !isTableCell(node);
        case NodeKind.Array:
            return top;
        case NodeKind.Paren:
            return isUnion(node.children[0]) || many(node.children[0], functions, top);
        case NodeKind.Postfix:
            return node.op === Token.Hash;
        case NodeKind.Binary:
            return node.op === Token.Colon || node.op === Token.Space;
        case NodeKind.Invoke:
            return node.children[0].sheetKind === SheetKind.External;
        case NodeKind.Call: {
            const entry = functions.get(node.text);
            if (entry === undefined) return !isExcel(node.text) || EXCEL_ARRAY_FUNCTIONS.has(node.text);
            if (entry.returns === ANYWHERE) return true;
            const { children } = node;
            // A row that answers a part of its table answers one cell in two written forms only: INDEX when each
            // index is a number other than 0 or a call of one value, XLOOKUP along a plain range into one line.
            if (entry.returns === PART) {
                const one =
                    node.text === 'INDEX'
                        ? children.slice(1, 3).every((index) => isIndex(index, functions))
                        : node.text === 'XLOOKUP' &&
                          children[1]?.kind === NodeKind.Ref &&
                          children[1].op !== RefKind.Cell &&
                          isLine(children[2]);
                if (!one) return true;
            }
            // A call that picks an argument answers what it picked, and one that makes an array of the cells of a
            // place, as ROW does, answers as many as the place holds.
            const spreads = entry.params.some((param) => param.read === Read.Room);
            for (let i = 0; i < children.length; i += 1) {
                const slot: Param<unknown> | undefined = slotOf(entry, i, children.length);
                const through = slot?.prepare === Prepare.Lazy || (spreads && slot?.read === Read.Here);
                if (through && many(children[i], functions, top)) return true;
            }
            return false;
        }
        default:
            return false;
    }
}

function isIndex(node: FormulaNode, functions: Registry): boolean {
    if (node.kind === NodeKind.Call) return !many(node, functions, false);
    return node.kind === NodeKind.Number && node.value !== 0;
}

// Whether a node is a reference to one row or one column, whatever cell it is read at.
function isLine(node: FormulaNode | undefined): boolean {
    if (node?.kind !== NodeKind.Ref || node.op === RefKind.Cell) return node?.kind === NodeKind.Ref;
    const { op, flags } = node;
    const rowFixed = (flags & RefFlag.RowAbsolute) !== 0;
    const columnFixed = (flags & RefFlag.ColumnAbsolute) !== 0;
    const row = node.row === node.row2 && rowFixed === ((flags & RefFlag.Row2Absolute) !== 0);
    const column = node.column === node.column2 && columnFixed === ((flags & RefFlag.Column2Absolute) !== 0);
    return (op !== RefKind.Columns && row) || (op !== RefKind.Rows && column);
}

function remade(node: FormulaNode, children: readonly FormulaNode[], text = node.text): FormulaNode {
    return branch(node.kind, node.op, text, children, node.space, node.spaceOpen, node.spaceEnd);
}

function call(name: string, argument: FormulaNode, space: string): FormulaNode {
    return branch(NodeKind.Call, 0, name, [argument], space, '', '');
}

function bracketed(node: FormulaNode): FormulaNode {
    return branch(NodeKind.Paren, 0, '', [node], '', '', '');
}

// The whitespace before the first token of a node, which for an operator with a left operand is that operand's.
function leading(node: FormulaNode): string {
    return leftmost(node).space;
}

function leftmost(node: FormulaNode): FormulaNode {
    let first = node;
    while (startsWithChild(first)) [first] = first.children;
    return first;
}

function startsWithChild(node: FormulaNode): boolean {
    return node.kind === NodeKind.Binary || node.kind === NodeKind.Postfix || node.kind === NodeKind.Invoke;
}

// The node with `space` before its first token.
function indent(node: FormulaNode, space: string): FormulaNode {
    if (leading(node) === space) return node;
    if (startsWithChild(node)) return remade(node, [indent(node.children[0], space), ...node.children.slice(1)]);
    if (node.kind === NodeKind.Ref) {
        const { op, sheetKind, sheet, row, column, row2, column2, flags } = node;
        return referenceNode(op, space, sheetKind, sheet, row, column, row2, column2, flags);
    }
    if (node.kind <= NodeKind.Error || node.kind === NodeKind.Name || node.kind === NodeKind.Table) {
        return leaf(node.kind, node.value, node.text, space, node.sheetKind, node.sheet);
    }
    return branch(node.kind, node.op, node.text, node.children, space, node.spaceOpen, node.spaceEnd);
}
