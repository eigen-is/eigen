// The evaluator: one recursive switch over a shape's tree, with the cell the formula sits in as arguments, since
// the tree itself holds offsets and belongs to every cell of its shape. A reference stays a reference until
// something needs its value, and reading a cell goes through the recalc, which computes a formula that is still
// to be computed first. So the order of a recalc comes from these reads.

import type { Registry } from '../functions/registry';
import type { Recalc } from '../recalc/recalc';
import type { Sheet } from '../store/sheet';
import type { Workbook } from '../store/workbook';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import { ERROR_LITERALS, Token } from '../text/lexer';
import type { Ends, FormulaNode } from '../text/tree';
import { endsAt, NodeKind, RefFlag, RefKind, SheetKind } from '../text/tree';
import type { FormulaError } from '../values/errors';
import { errorOf, NAME, NULL, REF, VALUE } from '../values/errors';
import type { ArrayValue, Reference, Scalar, Value } from '../values/value';
import { arrayOf, isArray, isError, isReference, ValueType } from '../values/value';
import { call } from './call';
import { lift } from './lift';
import { LIFTED_BINARY, LIFTED_NEGATE, LIFTED_PERCENT, negate, operate, percent } from './operators';
import { Frame, Room } from './readers';
import type { Entry } from './signature';
import { toArray } from './views';
import { Walk } from './walk';

// The error of each error literal, by its place in the list of literals.
const LITERAL_ERRORS = ERROR_LITERALS.map(errorOf);

export class Evaluator {
    public readonly workbook: Workbook;
    public readonly functions: Registry;
    public readonly recalc: Recalc;
    // The argument lists of the calls in progress, one per level of nesting, reused from call to call.
    public readonly frames: Frame[] = [];
    public calls = 0;
    public readonly walk = new Walk(this);
    public readonly room = new Room(this);
    // The date and time of the pass in progress as a serial, which its author handed over with the seed of its draws.
    public now = 0;
    private drawn = 0;
    // Where endsAt writes the rows or columns of the reference being read.
    private readonly ends: Ends = { first: 0, second: 0 };
    // Where a reference that is read as an array marks its rows and its columns that hold a cell.
    private rowMarks = new Uint8Array(64);
    private columnMarks = new Uint8Array(64);
    private placed: Sheet | null = null;
    private placedAt = 0;
    // The value of each array constant met, which is the same for every cell that holds it.
    private readonly constants = new WeakMap<FormulaNode, Scalar | ArrayValue>();

    public constructor(workbook: Workbook, functions: Registry, recalc: Recalc) {
        this.workbook = workbook;
        this.functions = functions;
        this.recalc = recalc;
    }

    // What the cell of a formula stores: one value, the top-left of an array, and 0 for a blank.
    public result(tree: FormulaNode, sheet: Sheet, row: number, column: number): Scalar {
        // Only the last + or - of a formula snaps a result that is tiny against its left operand to 0.
        const root = tree.kind === NodeKind.Binary && (tree.op === Token.Plus || tree.op === Token.Minus);
        const value = root
            ? this.read(this.binary(tree, sheet, row, column, true))
            : this.operand(tree, sheet, row, column);
        if (!isArray(value)) return value === null ? 0 : value;
        const first = this.first(value.items[0]);
        return first === null ? 0 : first;
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
                return LITERAL_ERRORS[node.value - 1];
            case NodeKind.Empty:
                return null;
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
                return isArray(value)
                    ? this.lifted(LIFTED_PERCENT, value, undefined, node, sheet, row, column)
                    : percent(value);
            }
            case NodeKind.Binary:
                return this.binary(node, sheet, row, column, false);
            case NodeKind.Paren:
                return this.evaluate(node.children[0], sheet, row, column);
            case NodeKind.Array:
                return this.constant(node);
            default: {
                const unknown: never = node.kind;
                return unknown;
            }
        }
    }

    // A value that is read: the cell of a reference, or the array of its cells.
    public operand(node: FormulaNode, sheet: Sheet, row: number, column: number): Scalar | ArrayValue {
        if (node.kind === NodeKind.Ref && node.op === RefKind.Cell) {
            const target = this.sheetOf(node, sheet);
            // Written out, where a range goes through endsAt: most of what a recalc reads is one cell.
            const r = node.flags & RefFlag.RowAbsolute ? node.row : row + node.row;
            const c = node.flags & RefFlag.ColumnAbsolute ? node.column : column + node.column;
            if (target === undefined || r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLUMNS) return REF;
            return this.recalc.valueOf(target, r, c);
        }
        return this.read(this.evaluate(node, sheet, row, column));
    }

    public read(value: Value): Scalar | ArrayValue {
        if (typeof value !== 'object' || value === null) return value;
        switch (value.type) {
            case ValueType.Reference:
                if (value.next !== null) return VALUE;
                if (value.top === value.bottom && value.left === value.right) {
                    return this.recalc.valueOf(this.workbook.sheets[value.sheet], value.top, value.left);
                }
                return toArray(this, value);
            default:
                return value;
        }
    }

    public clock(now: number, seed: number): void {
        this.now = now;
        this.drawn = seed | 0;
    }

    // The next number in [0, 1) of the pass, the same on every machine for one seed.
    public draw(): number {
        this.drawn = (this.drawn + 0x6d2b79f5) | 0;
        let mixed = Math.imul(this.drawn ^ (this.drawn >>> 15), 1 | this.drawn);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    }

    // The cell a formula is in, as a reference.
    public here(sheet: Sheet, row: number, column: number): Reference {
        const here = this.place(sheet);
        return {
            type: ValueType.Reference,
            sheet: here,
            top: row,
            left: column,
            bottom: row,
            right: column,
            next: null,
        };
    }

    // An element of an array as a value: of a reference its first cell.
    public first(item: Scalar | Reference): Scalar {
        if (!isReference(item)) return item;
        return this.recalc.valueOf(this.workbook.sheets[item.sheet], item.top, item.left);
    }

    // `count` cleared marks, for rows or for columns. They are good until the next reference is read as an array.
    public marks(count: number, rows: boolean): Uint8Array {
        let marks = rows ? this.rowMarks : this.columnMarks;
        if (marks.length >= count) return marks.fill(0, 0, count);
        marks = new Uint8Array(count);
        if (rows) this.rowMarks = marks;
        else this.columnMarks = marks;
        return marks;
    }

    // The place of a sheet in the workbook. Most formulas name their own sheet, so the last answer is kept.
    public place(sheet: Sheet): number {
        if (sheet !== this.placed) {
            this.placed = sheet;
            this.placedAt = this.workbook.sheets.indexOf(sheet);
        }
        return this.placedAt;
    }

    private sheetOf(node: FormulaNode, host: Sheet): Sheet | undefined {
        if (node.sheetKind === SheetKind.Host) return host;
        return node.sheetKind === SheetKind.Id ? this.workbook.sheet(node.sheet) : undefined;
    }

    private reference(node: FormulaNode, host: Sheet, row: number, column: number): Reference | FormulaError {
        const sheet = this.sheetOf(node, host);
        if (sheet === undefined) return REF;
        const { ends } = this;
        let top = 0;
        let bottom = GRID_ROWS - 1;
        let left = 0;
        let right = GRID_COLUMNS - 1;
        if (node.op !== RefKind.Columns) {
            if (!endsAt(node, true, row, GRID_ROWS, ends)) return REF;
            top = Math.min(ends.first, ends.second);
            bottom = Math.max(ends.first, ends.second);
        }
        if (node.op !== RefKind.Rows) {
            if (!endsAt(node, false, column, GRID_COLUMNS, ends)) return REF;
            left = Math.min(ends.first, ends.second);
            right = Math.max(ends.first, ends.second);
        }
        return { type: ValueType.Reference, sheet: this.place(sheet), top, left, bottom, right, next: null };
    }

    private prefix(node: FormulaNode, sheet: Sheet, row: number, column: number): Value {
        const child = node.children[0];
        // A unary plus changes nothing, not even a text into a number, but what it gives is a value and no cell.
        if (node.op === Token.Plus) return this.operand(child, sheet, row, column);
        if (node.op === Token.Minus) {
            const value = this.operand(child, sheet, row, column);
            return isArray(value)
                ? this.lifted(LIFTED_NEGATE, value, undefined, node, sheet, row, column)
                : negate(value);
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
    private binary(node: FormulaNode, sheet: Sheet, row: number, column: number, snap: boolean): Value {
        let chain: FormulaNode[] | null = null;
        let first = node;
        for (; first.children[0].kind === NodeKind.Binary; first = first.children[0]) (chain ??= []).push(first);
        const start = first.children[0];
        const left = isReferenceOperator(first.op)
            ? this.evaluate(start, sheet, row, column)
            : this.operand(start, sheet, row, column);
        let value = this.operation(first, left, sheet, row, column, snap && chain === null);
        if (chain === null) return value;
        for (let i = chain.length - 1; i >= 0; i -= 1) {
            value = this.operation(chain[i], value, sheet, row, column, snap && i === 0);
        }
        return value;
    }

    // One operator, with its left operand already evaluated.
    private operation(node: FormulaNode, left: Value, sheet: Sheet, row: number, column: number, snap: boolean): Value {
        const { op } = node;
        if (isReferenceOperator(op)) {
            if (isError(left)) return left;
            const right = this.evaluate(node.children[1], sheet, row, column);
            if (isError(right)) return right;
            return isReference(left) && isReference(right) ? combine(op, left, right) : VALUE;
        }
        const a = this.read(left);
        const b = this.operand(node.children[1], sheet, row, column);
        if (isArray(a) || isArray(b)) return this.lifted(LIFTED_BINARY[op], a, b, node, sheet, row, column);
        return operate(op, a, b, snap);
    }

    // An operator over an array runs once per element, as a call does: its operands are the arguments of a level
    // of calls of their own, since reading an element can compute a cell whose formula calls a function.
    private lifted(
        entry: Entry,
        a: Value,
        b: Value | undefined,
        node: FormulaNode,
        sheet: Sheet,
        row: number,
        column: number,
    ): Value {
        const level = this.calls;
        const frame = (this.frames[level] ??= new Frame(this));
        frame.held.length = 0;
        frame.held.push(a);
        if (b !== undefined) frame.held.push(b);
        this.calls = level + 1;
        const result = lift(this, entry, frame, frame.held.length, node, sheet, row, column);
        this.calls = level;
        return result;
    }

    private constant(node: FormulaNode): Scalar | ArrayValue {
        let value = this.constants.get(node);
        if (value !== undefined) return value;
        const items = node.children.map((element): Scalar => {
            switch (element.kind) {
                case NodeKind.Number:
                    return element.value;
                case NodeKind.String:
                    return element.text;
                case NodeKind.Boolean:
                    return element.value !== 0;
                case NodeKind.Error:
                    return LITERAL_ERRORS[element.value - 1];
                default:
                    return element.op === Token.Minus ? 0 - element.children[0].value : element.children[0].value;
            }
        });
        value = arrayOf(items.length / node.op, node.op, items);
        this.constants.set(node, value);
        return value;
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
