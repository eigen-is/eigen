// An operator over arrays: one loop that runs the operator once per element of its operands lined up, and makes
// the array of the answers. An operand is one value, a computed array, or a range, whose cells are read from their
// columns and never copied into an array of values. Each operand is first laid out as a cell is stored, a kind
// and a number per element, so the loop adds two numbers or compares two texts of cells without making a value
// of either; every other pair goes to the operator on two values, which is what each element answers.

import { CellKind, KIND_MASK } from '../store/column';
import { Token } from '../text/lexer';
import { CALC, NA, VALUE } from '../values/errors';
import { textKey } from '../values/text-order';
import type { ArrayValue, Reference, Scalar, Value } from '../values/value';
import { arrayOf, isArray, isError, LONGEST_TEXT } from '../values/value';
import type { Evaluator } from './evaluator';
import type { Lined } from './lift';
import { lineUp, single } from './lift';
import { arithmetic, compare, negate, operate, percent, real } from './operators';
import { Banded } from './views';

// An operand as an operator takes it: read, but a range still on its sheet.
export type Term = Scalar | ArrayValue | Banded;

export function isSpread(term: Term): term is ArrayValue | Banded {
    return term instanceof Banded || isArray(term);
}

// The operator `op` on `a` and `b`, or with no `b` the sign `op` on `a`: one of the two is an array or a range.
// The left element is read before the right one, as the left operand was before the right one was evaluated.
export function elementwise(ctx: Evaluator, op: number, a: Term, b?: Term): Value {
    const arrays: (ArrayValue | Banded)[] = [];
    const first = isSpread(a) ? arrays.push(a) - 1 : -1;
    const second = b !== undefined && isSpread(b) ? arrays.push(b) - 1 : -1;
    const lined = lineUp(ctx, arrays, false);
    if (lined === null) return CALC;
    const count = lined.down.count * lined.across.count;
    const sign = b === undefined;
    const keyed = op >= Token.Equal;
    const left = new Operand(ctx, a, lined, first, keyed);
    // A sign has no right operand: its left one stands in, and is never read as one.
    const right = b === undefined ? left : new Operand(ctx, b, lined, second, keyed);
    const { kind: leftKind, num: leftNum, ref: leftRef } = left;
    const { kind: rightKind, num: rightNum, ref: rightRef } = right;
    // One value is laid out once, and every element reads it there.
    const leftStep = first < 0 ? 0 : 1;
    const rightStep = second < 0 ? 0 : 1;
    const numeric = !sign && op < Token.Concat;
    const equality = op === Token.Equal || op === Token.NotEqual;
    // A comparison and a joined text are never a number.
    let nums = op >= Token.Concat ? null : new Float64Array(count);
    const items: Scalar[] = [];
    for (let at = 0; at < count; at += 1) {
        const i = at * leftStep;
        const j = at * rightStep;
        let item: Scalar;
        if (sign) item = signed(op, left.value(i));
        else if (numeric && leftKind[i] <= CellKind.Boolean && rightKind[j] <= CellKind.Boolean) {
            item = arithmetic(op, leftNum[i], rightNum[j]);
        } else if (equality && leftKind[i] === CellKind.Text && rightKind[j] === CellKind.Text) {
            // Two texts are equal when their keys are, and the string table holds each key once.
            item = (leftRef[i] === rightRef[j]) === (op === Token.Equal);
        } else {
            const x = left.value(i);
            const y = right.value(j);
            item = keyed ? compare(op, x, y, true) : operate(op, x, y, false);
        }
        // A text made for an element takes its length of the formula's work.
        if (typeof item === 'string' && !ctx.recalc.spend(item.length)) return CALC;
        if (nums !== null) {
            if (typeof item === 'number') {
                nums[at] = item;
                continue;
            }
            for (let k = 0; k < at; k += 1) items.push(nums[k]);
            nums = null;
        }
        items.push(item);
    }
    return arrayOf(lined.rows, lined.columns, nums ?? items, lined.down.ends, lined.across.ends);
}

// A sign on one element. What an operator on two values answers is a value a cell can hold already; what a sign
// leaves as it was is made one here, as the answer of a call is, and a blank is 0.
function signed(op: number, value: Scalar): Scalar {
    const result = op === Token.Plus ? value : op === Token.Minus ? negate(value) : percent(value);
    if (typeof result === 'number') return real(result);
    if (typeof result === 'string') return result.length > LONGEST_TEXT ? VALUE : result;
    return result ?? 0;
}

// The kind of an element that is no cell's kind: its value is read from the operand when the loop comes to it. It
// is a reference, which reading can compute, a text no cell holds, or an error only a file knows.
const READ = 5;

// One operand of an operation, laid out along its result as a column stores its cells: per element of the result
// a kind, a number, which is 1 for TRUE and 0 for what is no number, and the id of a text or the code of an error.
// One value is laid out once, for every element.
class Operand {
    public readonly kind: Uint8Array;
    public readonly num: Float64Array;
    // Of a comparison, the id of a text is that of its key, and -1 for a key the string table lacks.
    public readonly ref: Int32Array;
    private readonly ctx: Evaluator;
    // The stored block of an array, and of one value the value: of a comparison, a text as its key.
    private readonly items: ArrayLike<Scalar | Reference> | null;
    private readonly width: number;
    private readonly one: Scalar;
    private readonly banded: boolean;
    private readonly lined: Lined;
    // Whether a text is read as its key, which is what a comparison takes of it.
    private readonly keyed: boolean;
    // Per run of the result, the stored row and the stored column to read, and -1 past the end of the operand.
    // Null when the runs of the result are the operand's own.
    private readonly down: Int32Array | null;
    private readonly across: Int32Array | null;

    // `place` says which of the arrays that were lined up the operand is, and is -1 for one value.
    public constructor(ctx: Evaluator, term: Term, lined: Lined, place: number, keyed: boolean) {
        const count = place < 0 ? 1 : lined.down.count * lined.across.count;
        this.ctx = ctx;
        this.banded = term instanceof Banded;
        this.items = term instanceof Banded || !isArray(term) ? null : term.items;
        this.width = isSpread(term) ? term.width : 1;
        this.one = isSpread(term) ? null : keyed && typeof term === 'string' ? textKey(term) : term;
        this.lined = lined;
        this.keyed = keyed;
        this.down = place < 0 ? null : lined.down.from[place];
        this.across = place < 0 ? null : lined.across.from[place];
        this.kind = new Uint8Array(count);
        this.num = new Float64Array(count);
        this.ref = new Int32Array(count);
        if (term instanceof Banded) this.cells(term);
        else if (isArray(term)) this.elements(term);
        else this.lay(0, term);
        if (typeof this.one === 'string') {
            this.kind[0] = CellKind.Text;
            this.ref[0] = ctx.workbook.strings.find(this.one);
        }
    }

    // The value of the element at a place of the layout. A reference among the elements of an array is read
    // here, which can compute the cell it names.
    public value(at: number): Scalar {
        const kind = this.kind[at];
        if (kind === CellKind.Number) return this.num[at];
        if (kind === CellKind.Empty) return null;
        if (kind === CellKind.Boolean) return this.num[at] !== 0;
        const { ctx, items } = this;
        if (kind === CellKind.Error) return ctx.workbook.error(this.ref[at]);
        // Only a cell's text has an id to be read by.
        if (items === null) return this.banded ? ctx.workbook.strings.text(this.ref[at]) : this.one;
        const wide = this.lined.across.count;
        const r = Math.trunc(at / wide);
        const i = this.down === null ? r : this.down[r];
        const j = this.across === null ? at - r * wide : this.across[at - r * wide];
        const value = single(ctx, items[i * this.width + j]);
        return this.keyed && typeof value === 'string' ? textKey(value) : value;
    }

    // Lays out one value, or one element of an array. A text is left to be read: only a cell's has an id.
    private lay(at: number, value: Scalar | Reference): void {
        if (typeof value === 'number') {
            this.kind[at] = CellKind.Number;
            this.num[at] = value;
        } else if (typeof value === 'boolean') {
            this.kind[at] = CellKind.Boolean;
            this.num[at] = value ? 1 : 0;
        } else if (isError(value) && value.code > 0) {
            this.kind[at] = CellKind.Error;
            this.ref[at] = value.code;
        } else if (value !== null) this.kind[at] = READ;
    }

    private elements(array: ArrayValue): void {
        const { down, across } = this;
        const { items, width } = array;
        const high = this.lined.down.count;
        const wide = this.lined.across.count;
        for (let r = 0, at = 0; r < high; r += 1) {
            const i = down === null ? r : down[r];
            for (let c = 0; c < wide; c += 1, at += 1) {
                const j = across === null ? c : across[c];
                this.lay(at, i < 0 || j < 0 ? NA : items[i * width + j]);
            }
        }
    }

    private cells(cells: Banded): void {
        const { down, across, kind, num, ref, keyed } = this;
        const { strings } = this.ctx.workbook;
        const high = this.lined.down.count;
        const wide = this.lined.across.count;
        for (let c = 0; c < wide; c += 1) {
            const j = across === null ? c : across[c];
            const column = j < 0 ? undefined : cells.column(j);
            for (let r = 0; r < high; r += 1) {
                const at = r * wide + c;
                const i = down === null ? r : down[r];
                if (i < 0 || j < 0) this.lay(at, NA);
                if (i < 0 || column === undefined) continue;
                const row = cells.row(i);
                const held = column.kind[row] & KIND_MASK;
                kind[at] = held;
                if (held === CellKind.Number) num[at] = column.num[row];
                else if (held === CellKind.Boolean) num[at] = column.ref[row];
                else if (held === CellKind.Text) ref[at] = keyed ? strings.upper(column.ref[row]) : column.ref[row];
                else if (held === CellKind.Error) ref[at] = column.ref[row];
            }
        }
    }
}
