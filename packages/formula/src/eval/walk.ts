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
import { firstError } from './views';

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
    // How many cells were handed out so far.
    public count = 0;
    public error: FormulaError | null = null;
    private readonly ctx: Evaluator;
    private readonly one = new Float64Array(1);
    private args: readonly Value[] = [];
    private take = 0;
    private arg = 0;
    // The reference in progress, with the column and row to go on from, or the array, with the element.
    private area: Reference | null = null;
    private column = 0;
    private row = 0;
    private array: ArrayValue | null = null;
    private item = 0;

    public constructor(ctx: Evaluator) {
        this.ctx = ctx;
        this.num = this.one;
    }

    public start(args: readonly Value[], take: number): void {
        // Another aggregate can run while these formulas are computed, and it uses this same walk.
        for (const arg of args) {
            for (let area = isReference(arg) ? arg : null; area !== null; area = area.next) {
                this.ctx.cells.settleArea(area);
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
        if (isReference(value)) return this.enter(value);
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

    private enter(area: Reference | null): boolean {
        this.area = area;
        if (area === null) return false;
        this.column = area.left;
        this.row = area.top;
        const error = this.take <= Take.Truths ? firstError(this.ctx, area) : null;
        return error !== null && this.fail(error);
    }

    // The next stretch of cells of one kind that counts, down each column of the area in turn.
    private cells(area: Reference): boolean {
        const { columns } = area.sheet;
        const right = Math.min(area.right, columns.length - 1);
        const kinds = KINDS[this.take];
        for (; this.column <= right; this.column += 1, this.row = area.top) {
            const held = columns[this.column];
            const { kind } = held;
            const end = Math.min(area.bottom + 1, held.length);
            let row = this.row;
            while (row < end && ((kinds >> (kind[row] & KIND_MASK)) & 1) === 0) row += 1;
            if (row >= end) continue;
            const first = kind[row] & KIND_MASK;
            if (first === CellKind.Boolean && this.take === Take.Truths) {
                this.row = row + 1;
                return this.single(held.ref[row]);
            }
            let stop = row + 1;
            while (stop < end && (kind[stop] & KIND_MASK) === first) stop += 1;
            this.row = stop;
            this.num = held.num;
            this.from = row;
            this.to = stop;
            this.count += stop - row;
            return true;
        }
        return this.enter(area.next);
    }

    private elements(array: ArrayValue): boolean {
        const { items, nums } = array;
        if (nums !== null && this.item === 0) {
            this.array = null;
            this.num = nums;
            this.from = 0;
            this.to = nums.length;
            this.count += nums.length;
            return true;
        }
        while (this.item < items.length) {
            const item = items[this.item++];
            if (typeof item === 'number') return this.single(item);
            if (item === null) continue;
            if (typeof item === 'boolean' && this.take === Take.Truths) return this.single(item ? 1 : 0);
            if (this.take === Take.Filled) return this.single(0);
            if (isError(item) && this.take <= Take.Truths) return this.fail(item);
        }
        this.array = null;
        return false;
    }

    private single(value: number): boolean {
        this.one[0] = value;
        this.num = this.one;
        this.from = 0;
        this.to = 1;
        this.count += 1;
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
