// The one walk over the arguments of an aggregate such as SUM, MAX or AND. It hands the function spans of numbers
// to loop over, in argument order: a value typed as an argument once it is coerced, a stretch of a column's own
// plane for a reference, and the stored rows of an array. It skips what the function does not count, stops at the
// first error, and copies no range. The formulas in every reference are computed before the first span. It also
// adds what it hands out, since a stored row of an array can stand for a million written ones.

import { CellKind, KIND_MASK } from '../store/column';
import { toBoolean, toNumber } from '../values/coerce';
import type { FormulaError } from '../values/errors';
import { CALC } from '../values/errors';
import { parseNumber } from '../values/parse-number';
import type { ArrayValue, Reference, Value } from '../values/value';
import { isArray, isError, isReference, OMITTED } from '../values/value';
import type { Evaluator } from './evaluator';
import { repeated } from './sum';

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

export type Take = (typeof Take)[keyof typeof Take];

// The most additions one sum makes one by one for cells an array does not store: a row of different numbers that
// stands for many written rows is added that many times over. A sum that needs more is #CALC!.
const MOST_ADDITIONS = 2 ** 27;

const NUMBER = 1 << CellKind.Number;
const EVERY = (1 << CellKind.Number) | (1 << CellKind.Boolean) | (1 << CellKind.Text) | (1 << CellKind.Error);
// Per `Take`, the kinds of cell that count, one bit per kind.
const KINDS = [NUMBER, NUMBER | (1 << CellKind.Boolean), NUMBER, EVERY];

export class Walk {
    // The span: `num` from `from` up to `to`. For Counted and Filled only its length means something.
    public num: Float64Array;
    public from = 0;
    public to = 0;
    // A span from an array is one stored row: how many equal elements each number stands for, null when each stands
    // for one, and how many written rows the whole span stands for. In written order every number comes `reps`
    // times and the span as a whole `rows` times.
    public reps: Int32Array | null = null;
    public rows = 1;
    // How many cells were handed out so far.
    public count = 0;
    public error: FormulaError | null = null;
    // After `add`, the sum before its last addition.
    public before = 0;
    // Whether blank elements of an array were passed since the last number handed out. A sum takes them for an
    // addition of 0, which a blank cell of a reference is not.
    private blank = false;
    private readonly ctx: Evaluator;
    // Where a value that lies in no plane is put to be handed out: one typed value, or the cells of one row.
    private span = new Float64Array(8);
    private widths = new Int32Array(8);
    private args: readonly Value[] = [];
    private take: Take = Take.Numbers;
    private arg = 0;
    // The reference in progress, with its last column, the row to go on from and the row to stop at, or the array
    // in progress, with the stored row to go on from.
    private area: Reference | null = null;
    private right = 0;
    private row = 0;
    private end = 0;
    private array: ArrayValue | null = null;
    private item = 0;
    // The additions made so far for cells that no array stores.
    private unstored = 0;

    public constructor(ctx: Evaluator) {
        this.ctx = ctx;
        this.num = this.span;
    }

    public start(args: readonly Value[], take: Take): void {
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
        this.reps = null;
        this.rows = 1;
        this.count = 0;
        this.error = null;
        this.blank = false;
        this.unstored = 0;
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

    // The sum of everything the walk still hands out, as adding the numbers one by one in written order gives it.
    public add(): number {
        let sum = 0;
        let before = 0;
        while (this.next()) {
            const { num, from, to, reps, rows } = this;
            if (reps === null && rows === 1) {
                for (let i = from; i < to - 1; i += 1) sum += num[i];
                before = sum;
                sum += num[to - 1];
                continue;
            }
            let cells = 0;
            let equal = true;
            for (let i = from; i < to; i += 1) {
                cells += reps === null ? 1 : reps[i];
                equal &&= num[i] === num[from];
            }
            if (equal) {
                before = repeated(sum, num[from], cells * rows - 1);
                sum = before + num[from];
                continue;
            }
            const more = (rows - 1) * (to - from);
            if (!this.ctx.recalc.room(more, MOST_ADDITIONS - this.unstored)) {
                this.fail(CALC);
                break;
            }
            this.unstored += more;
            for (let row = 0; row < rows; row += 1) {
                for (let i = from; i < to; i += 1) {
                    before = reps === null ? sum : repeated(sum, num[i], reps[i] - 1);
                    sum = before + num[i];
                }
            }
        }
        this.before = this.blank ? sum : before;
        return sum;
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
                this.blank = false;
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
            this.blank = false;
            this.count += found;
            return true;
        }
        return this.enter(area.next);
    }

    // The stored rows of the array, each handed out with the numbers in it that count. Of an array of numbers, a
    // stretch of rows that each stand for one written row is one span of the block itself.
    private elements(array: ArrayValue): boolean {
        const { items, nums, height, width, rowEnds, columnEnds } = array;
        const { take } = this;
        if (this.span.length < width) this.span = new Float64Array(width);
        if (this.widths.length < width) this.widths = new Int32Array(width);
        const { span, widths } = this;
        while (this.item < height) {
            const row = this.item;
            const rows = rowEnds === null ? 1 : rowEnds[row] - (row === 0 ? 0 : rowEnds[row - 1]);
            if (nums !== null && columnEnds === null && rows === 1) {
                let stop = rowEnds === null ? height : row + 1;
                while (rowEnds !== null && stop < height && rowEnds[stop] - rowEnds[stop - 1] === 1) stop += 1;
                this.item = stop;
                this.num = nums;
                this.from = row * width;
                this.to = stop * width;
                this.reps = null;
                this.rows = 1;
                this.blank = false;
                this.count += (stop - row) * width;
                return true;
            }
            this.item = row + 1;
            let found = 0;
            let cells = 0;
            for (let c = 0; c < width; c += 1) {
                const item = items[row * width + c];
                let number = 0;
                if (typeof item === 'number') number = item;
                else if (item === null) {
                    this.blank = true;
                    continue;
                } else if (typeof item === 'boolean' && take === Take.Truths) number = item ? 1 : 0;
                else if (isError(item) && take <= Take.Truths) return this.fail(item);
                else if (take !== Take.Filled) continue;
                this.blank = false;
                span[found] = number;
                widths[found] = columnEnds === null ? 1 : columnEnds[c] - (c === 0 ? 0 : columnEnds[c - 1]);
                cells += widths[found];
                found += 1;
            }
            if (found === 0) continue;
            this.num = span;
            this.from = 0;
            this.to = found;
            this.reps = columnEnds === null ? null : widths;
            this.rows = rows;
            this.count += cells * rows;
            return true;
        }
        this.array = null;
        this.reps = null;
        this.rows = 1;
        return false;
    }

    private single(value: number): boolean {
        this.span[0] = value;
        this.num = this.span;
        this.from = 0;
        this.to = 1;
        this.blank = false;
        this.count += 1;
        return true;
    }

    private fail(error: FormulaError): boolean {
        this.error = error;
        this.area = null;
        this.array = null;
        this.reps = null;
        this.rows = 1;
        this.arg = this.args.length;
        return false;
    }
}
