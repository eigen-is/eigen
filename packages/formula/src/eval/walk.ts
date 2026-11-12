// The one walk over the arguments of a function that takes every value, such as SUM, MAX or AND. It hands out
// spans of numbers in argument order: a typed value, a stretch of a column's own plane for a reference, the stored
// rows of an array, which can each stand for a million written ones, or, for arguments that are multiplied place by
// place, their products. What counts is the family's data. The call wrapper has computed every cell and found
// every error before the walk starts, so it meets none.

import type { Column } from '../store/column';
import { CellKind, KIND_MASK } from '../store/column';
import type { FormulaError } from '../values/errors';
import type { ArrayValue, Reference } from '../values/value';
import { isArray, isError, isReference } from '../values/value';
import type { Evaluator } from './evaluator';
import { Fact } from './facts';
import type { Family } from './families';
import { Element, Errors, Families } from './families';
import { Products } from './products';
import type { Held } from './signature';

export class Walk {
    // The span: `num` from `from` up to `to`. Of a cell or an element that is no number only the count means something.
    public num: Float64Array;
    public from = 0;
    public to = 0;
    // How many cells were handed out so far, or how many places the arguments have that are multiplied.
    public count = 0;
    // Set when adding what the walk hands out would take more than the formula may: the call is then #CALC!.
    public error: FormulaError | null = null;
    // After the walk was added, the sum before its last addition.
    public before = 0;
    // Of a stored row of an array, how often each number of the span comes in a written row, null for once, and
    // how many written rows the row stands for.
    public reps: Int32Array | null = null;
    public rows = 1;
    private readonly ctx: Evaluator;
    // Where what lies in no one plane is put to be handed out: a typed value, or the cells of several columns.
    private span = new Float64Array(1024);
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
    // The columns of that reference, or of the arguments that are multiplied, that reach the row in hand.
    private readonly reach = new Reach();
    private array: ArrayValue | null = null;
    private item = 0;
    // Whether a span that `hand` was given is still to be handed out.
    private handed = false;
    private skips = 0;
    // Whether the arguments are multiplied place by place, and what then makes the spans.
    private multiplied = false;
    private readonly products: Products;

    public constructor(ctx: Evaluator) {
        this.ctx = ctx;
        this.num = this.span;
        this.products = new Products(ctx, this.reach);
    }

    // The arguments `from` up to `to`, as the wrapper read them: a number counts. `skips` says which cells are
    // passed over whatever they hold.
    public start(args: readonly Held[], from: number, to: number, family: Family, skips: number): void {
        this.args = args;
        this.family = family;
        this.skips = skips;
        this.arg = from;
        this.last = to;
        this.area = null;
        this.array = null;
        this.reps = null;
        this.rows = 1;
        this.count = 0;
        this.error = null;
        this.handed = false;
        this.multiplied = false;
    }

    // The arguments of the walk, which are of one size, as their products place by place: every place counts.
    public multiply(): void {
        this.multiplied = true;
        this.count = this.products.start(this, this.args, this.arg, this.last);
    }

    // The first `count` of `numbers` as the one span of a walk that has no arguments: numbers that lie in no
    // argument, such as the ones beside the cells that met the criteria of a call.
    public hand(numbers: Float64Array, count: number): void {
        this.num = numbers;
        this.from = 0;
        this.to = count;
        this.handed = count > 0;
    }

    // Moves to the next span. False when there is none.
    public next(): boolean {
        for (;;) {
            if (this.area !== null) {
                if (this.cells(this.area)) return true;
            } else if (this.array !== null) {
                if (this.elements(this.array)) return true;
            } else if (this.multiplied) return this.products.next(this);
            else if (this.arg === this.last) {
                if (!this.handed) return false;
                this.handed = false;
                this.count = this.to;
                return true;
            } else if (this.argument(this.args[this.arg++])) return true;
            if (this.error !== null) return false;
        }
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

    // What an element of an array that is a reference is to a family: the number it counts as, NaN when it is
    // passed over, or the error the call answers. The one place that reads this of a family, before the body for
    // the error and in the walk for the number. A first cell is computed when it is read.
    public referred(at: Reference, family: Family): number | FormulaError {
        const { element } = family;
        if (element === Element.Passed) return Number.NaN;
        if (element === Element.Counted) return 0;
        if (element !== Element.First) return element;
        const first = this.ctx.first(at);
        return isError(first) && family.errors === Errors.Result ? first : this.counted(at, family, 0);
    }

    private cell(at: Reference): boolean {
        const number = this.counted(at, this.family, this.skips);
        return !Number.isNaN(number) && this.single(number);
    }

    // What the first cell of a reference counts as, or NaN when it does not count.
    private counted(at: Reference, family: Family, skips: number): number {
        const held = this.ctx.workbook.sheets[at.sheet].columns[at.left];
        if (held === undefined || at.top >= held.length) return Number.NaN;
        const kind = held.kind[at.top] & KIND_MASK;
        if (((family.kinds >> kind) & 1) === 0 || skipped(this.ctx, skips, held, at.top)) return Number.NaN;
        return kind === CellKind.Boolean ? held.ref[at.top] : held.num[at.top];
    }

    private enter(area: Reference | null): boolean {
        this.area = area;
        if (area === null) return false;
        const { columns } = this.ctx.workbook.sheets[area.sheet];
        this.right = Math.min(area.right, columns.length - 1);
        this.row = area.top;
        this.end = 0;
        const width = Math.max(0, this.right - area.left + 1);
        this.reach.clear(width);
        if (this.span.length < width) this.span = new Float64Array(width);
        for (let c = area.left; c <= this.right; c += 1) {
            const end = Math.min(area.bottom + 1, columns[c].length);
            this.reach.add(c, end);
            this.end = Math.max(this.end, end);
        }
        return false;
    }

    // The cells of the area that count, row by row: of one column a stretch of its own plane, and of several the
    // cells of as many rows as the span holds, gathered.
    private cells(area: Reference): boolean {
        const { right, end, span, reach } = this;
        const tall = reach.columns;
        const { columns } = this.ctx.workbook.sheets[area.sheet];
        const { kinds } = this.family;
        if (this.row < end && area.left === right && this.skips === 0) {
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
        // Cell by cell for several columns, and for one column when cells may be passed over.
        let found = 0;
        let row = this.row;
        let live = reach.count;
        for (; row < end && (area.left < right || this.skips !== 0); row += 1) {
            if (row >= reach.shortest) live = reach.cut(row);
            if (found + live > span.length) break;
            for (let i = 0; i < live; i += 1) {
                const held = columns[tall[i]];
                if (skipped(this.ctx, this.skips, held, row)) continue;
                const at = held.kind[row] & KIND_MASK;
                if ((kinds >> at) & 1) span[found++] = at === CellKind.Boolean ? held.ref[row] : held.num[row];
            }
        }
        this.row = row;
        if (found === 0) return this.enter(area.next);
        this.num = span;
        this.from = 0;
        this.to = found;
        this.count += found;
        return true;
    }

    // The stored rows of the array, each handed out with the numbers in it that count. Of an array of numbers, a
    // stretch of rows that each stand for one written row is one span of the block itself.
    private elements(array: ArrayValue): boolean {
        const { items, nums, height, width, rowEnds, columnEnds } = array;
        const { kinds } = this.family;
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
                // A blank element is a 0 that counts, for every family, which a blank cell never is.
                if (typeof item === 'number') number = item;
                else if (isReference(item)) {
                    const referred = this.referred(item, this.family);
                    if (typeof referred !== 'number' || Number.isNaN(referred)) continue;
                    number = referred;
                } else if (typeof item === 'boolean') {
                    if (((kinds >> CellKind.Boolean) & 1) === 0) continue;
                    number = item ? 1 : 0;
                } else if (item !== null) {
                    if (((kinds >> (typeof item === 'string' ? CellKind.Text : CellKind.Error)) & 1) === 0) continue;
                }
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

    public fail(error: FormulaError): boolean {
        this.error = error;
        this.multiplied = false;
        this.area = null;
        this.array = null;
        this.reps = null;
        this.rows = 1;
        this.arg = this.last;
        return false;
    }
}

// The columns of a range that reach the row a walk is at. A column that ends above a row is left out from there
// on, so a row costs the columns that hold a cell in it, however wide the range is.
export class Reach {
    // The columns that are left, the first `count` of the list, and the row at which the shortest of them ends.
    public columns = new Int32Array(8);
    public count = 0;
    public shortest = 0;
    private ends = new Int32Array(8);

    // Starts over with no column, and room for `most`.
    public clear(most: number): void {
        if (this.columns.length < most) {
            this.columns = new Int32Array(most);
            this.ends = new Int32Array(most);
        }
        this.count = 0;
        this.shortest = 0;
    }

    public add(column: number, end: number): void {
        this.columns[this.count] = column;
        this.ends[this.count] = end;
        this.count += 1;
    }

    // Leaves out the columns that end at `row` or above it, and says how many are left.
    public cut(row: number): number {
        const { columns, ends } = this;
        let kept = 0;
        let shortest = Number.POSITIVE_INFINITY;
        for (let i = 0; i < this.count; i += 1) {
            const end = ends[i];
            if (end <= row) continue;
            columns[kept] = columns[i];
            ends[kept] = end;
            kept += 1;
            if (end < shortest) shortest = end;
        }
        this.count = kept;
        this.shortest = shortest;
        return kept;
    }
}

// Whether a cell is passed over whatever it holds, an error too: with `skips`, one whose formula holds a call of a
// row that picks another.
export function skipped(ctx: Evaluator, skips: number, held: Column, row: number): boolean {
    if (skips === 0 || held.shape[row] === 0) return false;
    return (ctx.recalc.factsOf(held.shape[row]) & Fact.Chosen) !== 0;
}
