// The one walk over the arguments of a function that takes every value, such as SUM, MAX or AND. It hands out
// spans of numbers in argument order: a value typed as an argument, a stretch of a column's own plane for a
// reference, and the stored rows of an array. What counts is the family's data. The call wrapper has computed every
// cell and found every error before the walk starts, so it meets none. It also adds what it hands out, since a
// stored row of an array can stand for a million written ones.

import { CellKind, KIND_MASK } from '../store/column';
import type { FormulaError } from '../values/errors';
import { CALC } from '../values/errors';
import type { ArrayValue, Reference } from '../values/value';
import { isArray, isReference, MOST_ELEMENTS } from '../values/value';
import type { Evaluator } from './evaluator';
import type { Family } from './families';
import { Families } from './families';
import type { Held } from './signature';
import { repeated } from './sum';

// The most additions one sum makes one by one for cells an array does not store: a row of different numbers that
// stands for many written rows is added that many times over. A sum that needs more is #CALC!.
const MOST_ADDITIONS = 2 ** 27;

export class Walk {
    // The span: `num` from `from` up to `to`. Of a cell or an element that is no number only the count means something.
    public num: Float64Array;
    public from = 0;
    public to = 0;
    // How many cells were handed out so far.
    public count = 0;
    // Set when the walk would add or list more than it may: the call is then #CALC!.
    public error: FormulaError | null = null;
    // After `add`, the sum before its last addition.
    public before = 0;
    // Of a stored row of an array: how many equal elements each number stands for, null when each stands for one,
    // and how many written rows the row stands for. In written order each number comes `reps` times, all of it `rows`.
    private reps: Int32Array | null = null;
    private rows = 1;
    private readonly ctx: Evaluator;
    // Where a value that lies in no plane is put to be handed out: one typed value, or the cells of one row.
    private span = new Float64Array(8);
    private widths = new Int32Array(8);
    private args: readonly Held[] = [];
    private family: Family = Families.Numbers;
    private arg = 0;
    private last = 0;
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

    // The arguments `from` up to `to`, as the wrapper read them: a number counts, and nothing is passed over.
    public start(args: readonly Held[], from: number, to: number, family: Family): void {
        this.args = args;
        this.family = family;
        this.arg = from;
        this.last = to;
        this.area = null;
        this.array = null;
        this.reps = null;
        this.rows = 1;
        this.count = 0;
        this.error = null;
        this.unstored = 0;
    }

    // Moves to the next span. False when there is none.
    public next(): boolean {
        for (;;) {
            if (this.area !== null) {
                if (this.cells(this.area)) return true;
            } else if (this.array !== null) {
                if (this.elements(this.array)) return true;
            } else if (this.arg === this.last) return false;
            else if (this.argument(this.args[this.arg++])) return true;
            if (this.error !== null) return false;
        }
    }

    // The sum of everything the walk still hands out, as adding the numbers one by one in written order gives it.
    public add(): number {
        let sum = 0;
        let before = 0;
        while (this.next()) {
            if (this.reps !== null || this.rows !== 1) {
                sum = this.addRow(sum);
                before = this.before;
                continue;
            }
            const { num, to } = this;
            for (let i = this.from; i < to - 1; i += 1) sum += num[i];
            before = sum;
            sum += num[to - 1];
        }
        this.before = before;
        return sum;
    }

    // Every number the walk still hands out, once per written cell in written order, into `list` or a longer one.
    public gather(list: Float64Array): Float64Array {
        let into = list;
        let at = 0;
        while (this.next()) {
            const { num, from, to, reps, rows } = this;
            let cells = 0;
            for (let i = from; i < to; i += 1) cells += reps === null ? 1 : reps[i];
            if (at + cells * rows > MOST_ELEMENTS) {
                this.fail(CALC);
                break;
            }
            if (at + cells * rows > into.length) {
                const longer = new Float64Array(Math.max(into.length * 2, at + cells * rows));
                longer.set(into.subarray(0, at));
                into = longer;
            }
            for (let row = 0; row < rows; row += 1) {
                for (let i = from; i < to; i += 1) {
                    const end = at + (reps === null ? 1 : reps[i]);
                    while (at < end) into[at++] = num[i];
                }
            }
        }
        return into;
    }

    // `start` and a stored row of an array that stands for more than its own numbers, with the sum before the
    // last addition left in `before`. Only a row of different numbers that stands for many rows is a loop.
    private addRow(start: number): number {
        const { num, from, to, reps, rows } = this;
        let sum = start;
        let cells = 0;
        let equal = true;
        for (let i = from; i < to; i += 1) {
            cells += reps === null ? 1 : reps[i];
            equal &&= num[i] === num[from];
        }
        if (equal) {
            this.before = repeated(sum, num[from], cells * rows - 1);
            return this.before + num[from];
        }
        const more = (rows - 1) * (to - from);
        if (!this.ctx.recalc.room(more, MOST_ADDITIONS - this.unstored)) {
            this.fail(CALC);
            return sum;
        }
        this.unstored += more;
        for (let row = 0; row < rows; row += 1) {
            for (let i = from; i < to; i += 1) {
                this.before = reps === null ? sum : repeated(sum, num[i], reps[i] - 1);
                sum = this.before + num[i];
            }
        }
        return sum;
    }

    private argument(value: Held): boolean {
        if (isReference(value)) {
            const one = value.top === value.bottom && value.left === value.right && value.next === null;
            return one ? this.cell(value) : this.enter(value);
        }
        if (isArray(value)) {
            this.array = value;
            this.item = 0;
            return false;
        }
        return typeof value === 'number' && this.single(value);
    }

    private cell(at: Reference): boolean {
        const number = this.counted(at);
        return !Number.isNaN(number) && this.single(number);
    }

    // What the first cell of a reference counts as, or NaN when it does not count.
    private counted(at: Reference): number {
        const held = this.ctx.workbook.sheets[at.sheet].columns[at.left];
        if (held === undefined || at.top >= held.length) return Number.NaN;
        const kind = held.kind[at.top] & KIND_MASK;
        if (((this.family.kinds >> kind) & 1) === 0) return Number.NaN;
        return kind === CellKind.Boolean ? held.ref[at.top] : held.num[at.top];
    }

    private enter(area: Reference | null): boolean {
        this.area = area;
        if (area === null) return false;
        const { columns } = this.ctx.workbook.sheets[area.sheet];
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
        const { right, end, span } = this;
        const { columns } = this.ctx.workbook.sheets[area.sheet];
        const { kinds } = this.family;
        if (this.row < end && area.left === right) {
            const held = columns[right];
            const { kind } = held;
            let row = this.row;
            while (row < end && ((kinds >> (kind[row] & KIND_MASK)) & 1) === 0) row += 1;
            const first = kind[row] & KIND_MASK;
            if (row < end && first === CellKind.Boolean) {
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
            }
            if (found === 0) continue;
            this.row = row + 1;
            this.num = span;
            this.from = 0;
            this.to = found;
            this.count += found;
            return true;
        }
        return this.enter(area.next);
    }

    // The stored rows of the array, each handed out with the numbers in it that count. Of an array of numbers, a
    // stretch of rows that each stand for one written row is one span of the block itself.
    private elements(array: ArrayValue): boolean {
        const { items, nums, height, width, rowEnds, columnEnds } = array;
        const { kinds, first } = this.family;
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
                this.count += (stop - row) * width;
                return true;
            }
            this.item = row + 1;
            let found = 0;
            let cells = 0;
            for (let c = 0; c < width; c += 1) {
                const item = items[row * width + c];
                let number = 0;
                // A blank element is a 0 that counts, which a blank cell is not.
                if (typeof item === 'number') number = item;
                else if (isReference(item)) {
                    number = first ? this.counted(item) : Number.NaN;
                    if (Number.isNaN(number)) continue;
                } else if (typeof item === 'boolean' && (kinds >> CellKind.Boolean) & 1) number = item ? 1 : 0;
                else if (
                    item !== null &&
                    ((kinds >> (typeof item === 'string' ? CellKind.Text : CellKind.Error)) & 1) === 0
                )
                    continue;
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
        this.count += 1;
        return true;
    }

    private fail(error: FormulaError): boolean {
        this.error = error;
        this.area = null;
        this.array = null;
        this.reps = null;
        this.rows = 1;
        this.arg = this.last;
        return false;
    }
}
