// The one walk over the arguments of an aggregate such as SUM, MAX or AND. It hands the function spans of numbers
// to loop over, in argument order: a value typed as an argument once it is coerced, a stretch of a column's own
// plane for a reference, and the elements of an array. It skips what the function does not count, stops at the
// first error, and copies no range. The formulas in every reference are computed before the first span.

import { CellKind, KIND_MASK } from '../store/column';
import { toBoolean, toNumber } from '../values/coerce';
import type { FormulaError } from '../values/errors';
import { parseNumber } from '../values/parse-number';
import type { ArrayValue, Reference, Value } from '../values/value';
import { isArray, isError, isReference, OMITTED } from '../values/value';
import type { Evaluator } from './evaluator';

// Which cells an aggregate takes. A value typed as an argument is coerced where a cell would be skipped: for
// Numbers a text is read as a number and a boolean is 1 or 0, for Truths a number is TRUE unless it is 0.
export const Take = {
    // The numbers. An error is the result.
    Numbers: 0,
    // The numbers and the booleans, a boolean as 1 or 0. An error is the result.
    Truths: 1,
    // The numbers, to be counted: an error or a text that is no number is passed over.
    Counted: 2,
    // Everything but a blank, to be counted.
    Filled: 3,
} as const;

const NUMBER = 1 << CellKind.Number;
const EVERY = (1 << CellKind.Number) | (1 << CellKind.Boolean) | (1 << CellKind.Text) | (1 << CellKind.Error);
// Per `Take`, the kinds of cell that count, one bit per kind.
const KINDS = [NUMBER, NUMBER | (1 << CellKind.Boolean), NUMBER, EVERY];

export class Walk {
    // The span: `num` from `from` up to `to`. For Counted and Filled only its length means something.
    public num: Float64Array;
    public from = 0;
    public to = 0;
    // How many cells each number of the span stands for: more than 1 only for the last row or column of an array.
    public times = 1;
    // How many cells were handed out so far.
    public count = 0;
    public error: FormulaError | null = null;
    private readonly ctx: Evaluator;
    // Where a value that lies in no plane is put to be handed out: one typed value, or the cells of one row.
    private span = new Float64Array(8);
    private args: readonly Value[] = [];
    private take = 0;
    private arg = 0;
    // The reference in progress, with its last column, the row to go on from and the row to stop at, or the array
    // in progress, with the element to go on from.
    private area: Reference | null = null;
    private right = 0;
    private row = 0;
    private end = 0;
    private array: ArrayValue | null = null;
    private item = 0;

    public constructor(ctx: Evaluator) {
        this.ctx = ctx;
        this.num = this.span;
    }

    public start(args: readonly Value[], take: number): void {
        // Another aggregate can run while these formulas are computed, and it uses this same walk.
        for (const arg of args) {
            for (let area = isReference(arg) ? arg : null; area !== null; area = area.next) {
                this.ctx.recalc.settleArea(area);
            }
        }
        this.args = args;
        this.take = take;
        this.arg = 0;
        this.area = null;
        this.array = null;
        this.count = 0;
        this.error = null;
    }

    // Moves to the next span. False when there is none, or when an error ended the walk.
    public next(): boolean {
        for (;;) {
            if (this.area !== null) {
                if (this.cells(this.area)) return true;
            } else if (this.array !== null) {
                if (this.elements(this.array)) return true;
            } else if (this.arg === this.args.length) return false;
            else if (this.argument(this.args[this.arg++])) return true;
            if (this.error !== null) return false;
        }
    }

    private argument(value: Value): boolean {
        if (isReference(value)) {
            const one = value.top === value.bottom && value.left === value.right && value.next === null;
            return one ? this.cell(value) : this.enter(value);
        }
        if (isArray(value)) {
            this.array = value;
            this.item = 0;
            return false;
        }
        switch (this.take) {
            case Take.Numbers: {
                const number = value === OMITTED ? 0 : toNumber(value);
                return typeof number === 'number' ? this.single(number) : this.fail(number);
            }
            case Take.Truths: {
                const truth = value === OMITTED ? false : toBoolean(value);
                return typeof truth === 'boolean' ? this.single(truth ? 1 : 0) : this.fail(truth);
            }
            case Take.Counted:
                if (typeof value === 'string' ? parseNumber(value) === undefined : value === null || isError(value))
                    return false;
                return this.single(0);
            default:
                return this.single(0);
        }
    }

    private cell(at: Reference): boolean {
        const held = at.sheet.columns[at.left];
        if (held === undefined || at.top >= held.length) return false;
        const kind = held.kind[at.top] & KIND_MASK;
        if ((KINDS[this.take] >> kind) & 1) {
            return this.single(kind === CellKind.Boolean ? held.ref[at.top] : held.num[at.top]);
        }
        const strict = kind === CellKind.Error && this.take <= Take.Truths;
        return strict && this.fail(this.ctx.workbook.error(held.ref[at.top]));
    }

    private enter(area: Reference | null): boolean {
        this.area = area;
        if (area === null) return false;
        const { columns } = area.sheet;
        this.right = Math.min(area.right, columns.length - 1);
        this.row = area.top;
        this.end = 0;
        for (let c = area.left; c <= this.right; c += 1) {
            this.end = Math.max(this.end, Math.min(area.bottom + 1, columns[c].length));
        }
        if (this.span.length <= this.right - area.left) this.span = new Float64Array(this.right - area.left + 1);
        return false;
    }

    // The cells of the area that count, row by row: of one column a stretch of its own plane, and of several the
    // cells of one row, gathered.
    private cells(area: Reference): boolean {
        const { take, right, end, span } = this;
        const { columns } = area.sheet;
        const kinds = KINDS[take];
        const strict = take <= Take.Truths;
        if (this.row < end && area.left === right) {
            const held = columns[right];
            const { kind } = held;
            let row = this.row;
            for (; row < end; row += 1) {
                const at = kind[row] & KIND_MASK;
                if ((kinds >> at) & 1) break;
                if (at === CellKind.Error && strict) return this.fail(this.ctx.workbook.error(held.ref[row]));
            }
            const first = kind[row] & KIND_MASK;
            if (row < end && first === CellKind.Boolean && take === Take.Truths) {
                this.row = row + 1;
                return this.single(held.ref[row]);
            }
            if (row < end) {
                let stop = row + 1;
                while (stop < end && (kind[stop] & KIND_MASK) === first) stop += 1;
                this.row = stop;
                this.num = held.num;
                this.from = row;
                this.to = stop;
                this.times = 1;
                this.count += stop - row;
                return true;
            }
        }
        for (let row = this.row; row < end && area.left < right; row += 1) {
            let found = 0;
            for (let c = area.left; c <= right; c += 1) {
                const held = columns[c];
                if (row >= held.length) continue;
                const at = held.kind[row] & KIND_MASK;
                if ((kinds >> at) & 1) span[found++] = at === CellKind.Boolean ? held.ref[row] : held.num[row];
                else if (at === CellKind.Error && strict) return this.fail(this.ctx.workbook.error(held.ref[row]));
            }
            if (found === 0) continue;
            this.row = row + 1;
            this.num = span;
            this.from = 0;
            this.to = found;
            this.times = 1;
            this.count += found;
            return true;
        }
        return this.enter(area.next);
    }

    // The stored elements of the array that count, row by row. The last stored row and column are handed out once,
    // with the number of rows or columns they stand for in `times`.
    private elements(array: ArrayValue): boolean {
        const { items, nums, height, width } = array;
        const start = (height - 1) * width;
        const down = array.rows - height + 1;
        if (nums !== null && width === array.columns) {
            const whole = this.item === 0 && (down === 1 || start === 0);
            const to = this.item === 0 && !whole ? start : nums.length;
            this.num = nums;
            this.from = this.item;
            this.to = to;
            this.times = to === start ? 1 : down;
            this.count += (to - this.item) * this.times;
            this.item = to;
            if (to === nums.length) this.array = null;
            return true;
        }
        while (this.item < items.length) {
            const at = this.item++;
            const item = items[at];
            const times = (at < start ? 1 : down) * ((at + 1) % width === 0 ? array.columns - width + 1 : 1);
            if (typeof item === 'number') return this.single(item, times);
            if (item === null) continue;
            if (typeof item === 'boolean' && this.take === Take.Truths) return this.single(item ? 1 : 0, times);
            if (this.take === Take.Filled) return this.single(0, times);
            if (isError(item) && this.take <= Take.Truths) return this.fail(item);
        }
        this.array = null;
        return false;
    }

    private single(value: number, times = 1): boolean {
        this.span[0] = value;
        this.num = this.span;
        this.from = 0;
        this.to = 1;
        this.times = times;
        this.count += times;
        return true;
    }

    private fail(error: FormulaError): boolean {
        this.error = error;
        this.area = null;
        this.array = null;
        this.arg = this.args.length;
        return false;
    }
}
