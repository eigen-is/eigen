// The evaluator: one recursive switch over a shape's tree, with the cell the formula sits in as arguments, since
// the tree itself holds offsets and belongs to every cell of its shape. A reference stays a reference until
// something needs its value, and reading a cell goes through the recalc, which computes a formula that is still
// to be computed first. So the order of a recalc comes from these reads.

import type { Registry } from '../functions/registry';
import { PENDING } from '../functions/registry';
import type { Recalc } from '../recalc/recalc';
import type { Sheet } from '../store/sheet';
import type { Workbook } from '../store/workbook';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import { Token } from '../text/lexer';
import type { FormulaNode } from '../text/tree';
import { NodeKind, RefFlag, RefKind, SheetKind } from '../text/tree';
import { toNumber } from '../values/coerce';
import type { FormulaError } from '../values/errors';
import { ERRORS, NAME, NULL, REF, VALUE } from '../values/errors';
import { snapSum } from '../values/precision';
import type { ArrayValue, Reference, Scalar, Value } from '../values/value';
import { arrayOf, isArray, isError, isReference, OMITTED, ValueType } from '../values/value';
import { call, lift } from './call';
import { arithmetic, LIFTED_BINARY, LIFTED_NEGATE, LIFTED_PERCENT, negate, operate, percent } from './operators';
import { toArray } from './views';
import { Walk } from './walk';

export class Evaluator {
    public readonly workbook: Workbook;
    public readonly functions: Registry;
    public readonly cells: Recalc;
    // The argument lists of the calls in progress, one per level of nesting, reused from call to call.
    public readonly frames: Value[][] = [];
    public calls = 0;
    public readonly walk = new Walk(this);

    public constructor(workbook: Workbook, functions: Registry, cells: Recalc) {
        this.workbook = workbook;
        this.functions = functions;
        this.cells = cells;
    }

    // What the cell of a formula stores: one value, the top-left of an array, and 0 for a blank.
    public result(tree: FormulaNode, sheet: Sheet, row: number, column: number): Scalar {
        const root = tree.kind === NodeKind.Binary && (tree.op === Token.Plus || tree.op === Token.Minus);
        const value = root ? this.lastSum(tree, sheet, row, column) : this.operand(tree, sheet, row, column);
        const single = isArray(value) ? value.items[0] : value;
        return single === null ? 0 : single;
    }

    public evaluate(node: FormulaNode, sheet: Sheet, row: number, column: number): Value {
        switch (node.kind) {
            case NodeKind.Number:
                return node.value;
            case NodeKind.String:
                return node.text;
            case NodeKind.Boolean:
                return node.value !== 0;
            case NodeKind.Error:
                return ERRORS[node.value - 1];
            case NodeKind.Empty:
                return OMITTED;
            case NodeKind.Ref:
                return this.reference(node, sheet, row, column);
            case NodeKind.Name:
                return NAME;
            case NodeKind.Call:
                return call(this, node, sheet, row, column);
            case NodeKind.Invoke: {
                const called = this.evaluate(node.children[0], sheet, row, column);
                return isError(called) ? called : VALUE;
            }
            case NodeKind.Prefix:
                return this.prefix(node, sheet, row, column);
            case NodeKind.Postfix: {
                // Nothing spills in this build, so no cell is an anchor.
                if (node.op === Token.Hash) return REF;
                const value = this.operand(node.children[0], sheet, row, column);
                return isArray(value) ? lift(this, LIFTED_PERCENT, [value], node, sheet, row, column) : percent(value);
            }
            case NodeKind.Binary:
                return this.binary(node, sheet, row, column);
            case NodeKind.Paren:
                return this.evaluate(node.children[0], sheet, row, column);
            default:
                return this.constant(node);
        }
    }

    // A value that is read: the cell of a reference, or the array of its cells.
    public operand(node: FormulaNode, sheet: Sheet, row: number, column: number): Scalar | ArrayValue {
        if (node.kind === NodeKind.Ref && node.op === RefKind.Cell) {
            const target = this.sheetOf(node, sheet);
            const r = node.flags & RefFlag.RowAbsolute ? node.row : row + node.row;
            const c = node.flags & RefFlag.ColumnAbsolute ? node.column : column + node.column;
            if (target === undefined || r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLUMNS) return REF;
            return this.cells.valueOf(target, r, c);
        }
        return this.read(this.evaluate(node, sheet, row, column));
    }

    public read(value: Value): Scalar | ArrayValue {
        if (typeof value !== 'object' || value === null) return value;
        switch (value.type) {
            case ValueType.Reference:
                if (value.next !== null) return VALUE;
                if (value.top === value.bottom && value.left === value.right) {
                    return this.cells.valueOf(value.sheet, value.top, value.left);
                }
                return toArray(this, value);
            case ValueType.Omitted:
                return null;
            default:
                return value;
        }
    }

    // A lazy argument, evaluated now unless the wrapper already had to. One left empty is a blank from here on.
    public force(value: Value, node: FormulaNode, sheet: Sheet, row: number, column: number): Value {
        if (value !== PENDING) return value;
        return node.kind === NodeKind.Empty ? null : this.evaluate(node, sheet, row, column);
    }

    // Only the last + or - of a formula snaps a result that is tiny against its left operand to 0.
    private lastSum(node: FormulaNode, sheet: Sheet, row: number, column: number): Scalar | ArrayValue {
        const a = this.operand(node.children[0], sheet, row, column);
        const b = this.operand(node.children[1], sheet, row, column);
        if (isArray(a) || isArray(b))
            return this.read(lift(this, LIFTED_BINARY[node.op], [a, b], node, sheet, row, column));
        const x = toNumber(a);
        if (typeof x !== 'number') return x;
        const y = toNumber(b);
        if (typeof y !== 'number') return y;
        const sum = arithmetic(node.op, x, y);
        return typeof sum === 'number' ? snapSum(sum, x) : sum;
    }

    private sheetOf(node: FormulaNode, host: Sheet): Sheet | undefined {
        if (node.sheetKind === SheetKind.Host) return host;
        return node.sheetKind === SheetKind.Id ? this.workbook.sheet(node.sheet) : undefined;
    }

    private reference(node: FormulaNode, host: Sheet, row: number, column: number): Reference | FormulaError {
        const sheet = this.sheetOf(node, host);
        if (sheet === undefined) return REF;
        const { flags, op } = node;
        let top = 0;
        let bottom = GRID_ROWS - 1;
        let left = 0;
        let right = GRID_COLUMNS - 1;
        if (op !== RefKind.Columns) {
            top = flags & RefFlag.RowAbsolute ? node.row : row + node.row;
            bottom = op === RefKind.Cell ? top : flags & RefFlag.Row2Absolute ? node.row2 : row + node.row2;
        }
        if (op !== RefKind.Rows) {
            left = flags & RefFlag.ColumnAbsolute ? node.column : column + node.column;
            right = op === RefKind.Cell ? left : flags & RefFlag.Column2Absolute ? node.column2 : column + node.column2;
        }
        if (top > bottom) [top, bottom] = [bottom, top];
        if (left > right) [left, right] = [right, left];
        if (top < 0 || bottom >= GRID_ROWS || left < 0 || right >= GRID_COLUMNS) return REF;
        return { type: ValueType.Reference, sheet, top, left, bottom, right, next: null };
    }

    private prefix(node: FormulaNode, sheet: Sheet, row: number, column: number): Value {
        const child = node.children[0];
        // A unary plus changes nothing, not even a text into a number.
        if (node.op === Token.Plus) return this.evaluate(child, sheet, row, column);
        if (node.op === Token.Minus) {
            const value = this.operand(child, sheet, row, column);
            return isArray(value) ? lift(this, LIFTED_NEGATE, [value], node, sheet, row, column) : negate(value);
        }
        const value = this.evaluate(child, sheet, row, column);
        if (isArray(value)) return value.items[0];
        if (!isReference(value)) return value;
        if (value.next !== null) return VALUE;
        const oneRow = value.top === value.bottom;
        const oneColumn = value.left === value.right;
        if (oneRow && oneColumn) return value;
        if (oneColumn && row >= value.top && row <= value.bottom) return { ...value, top: row, bottom: row };
        if (oneRow && column >= value.left && column <= value.right) return { ...value, left: column, right: column };
        return VALUE;
    }

    // A long sum is a chain thousands of nodes deep down its left operands, so it runs in a loop from its first
    // operation up, and only a right operand is a call deeper.
    private binary(node: FormulaNode, sheet: Sheet, row: number, column: number): Value {
        let chain: FormulaNode[] | null = null;
        let first = node;
        for (; first.children[0].kind === NodeKind.Binary; first = first.children[0]) (chain ??= []).push(first);
        const start = first.children[0];
        const left = isReferenceOperator(first.op)
            ? this.evaluate(start, sheet, row, column)
            : this.operand(start, sheet, row, column);
        let value = this.operation(first, left, sheet, row, column);
        if (chain === null) return value;
        for (let i = chain.length - 1; i >= 0; i -= 1) value = this.operation(chain[i], value, sheet, row, column);
        return value;
    }

    // One operator, with its left operand already evaluated.
    private operation(node: FormulaNode, left: Value, sheet: Sheet, row: number, column: number): Value {
        const { op } = node;
        if (isReferenceOperator(op)) {
            if (isError(left)) return left;
            const right = this.evaluate(node.children[1], sheet, row, column);
            if (isError(right)) return right;
            return isReference(left) && isReference(right) ? combine(op, left, right) : VALUE;
        }
        const a = this.read(left);
        const b = this.operand(node.children[1], sheet, row, column);
        if (isArray(a) || isArray(b)) return lift(this, LIFTED_BINARY[op], [a, b], node, sheet, row, column);
        return operate(op, a, b);
    }

    private constant(node: FormulaNode): Value {
        const items = node.children.map((element): Scalar => {
            switch (element.kind) {
                case NodeKind.Number:
                    return element.value;
                case NodeKind.String:
                    return element.text;
                case NodeKind.Boolean:
                    return element.value !== 0;
                case NodeKind.Error:
                    return ERRORS[element.value - 1];
                default:
                    return element.op === Token.Minus ? 0 - element.children[0].value : element.children[0].value;
            }
        });
        return arrayOf(items.length / node.op, node.op, items);
    }
}

function isReferenceOperator(op: number): boolean {
    return op === Token.Colon || op === Token.Space || op === Token.Comma;
}

// The three operators on references: the box around two, the cells two share, and one after the other.
function combine(op: number, a: Reference, b: Reference): Reference | FormulaError {
    if (op === Token.Comma) return union(a, b);
    if (a.next !== null || b.next !== null) return VALUE;
    if (op === Token.Colon) {
        if (a.sheet !== b.sheet) return VALUE;
        return {
            ...a,
            top: Math.min(a.top, b.top),
            left: Math.min(a.left, b.left),
            bottom: Math.max(a.bottom, b.bottom),
            right: Math.max(a.right, b.right),
        };
    }
    const top = Math.max(a.top, b.top);
    const left = Math.max(a.left, b.left);
    const bottom = Math.min(a.bottom, b.bottom);
    const right = Math.min(a.right, b.right);
    return a.sheet !== b.sheet || top > bottom || left > right ? NULL : { ...a, top, left, bottom, right };
}

// A union can be thousands of areas long, so the areas of `a` are copied in a loop, last one first.
function union(a: Reference, b: Reference): Reference {
    const areas: Reference[] = [];
    for (let area: Reference | null = a; area !== null; area = area.next) areas.push(area);
    let joined = b;
    for (let i = areas.length - 1; i >= 0; i -= 1) joined = { ...areas[i], next: joined };
    return joined;
}
