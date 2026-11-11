// What a function's body gets in place of a range: a reader the call wrapper has prepared, so no body touches a
// cell, a column or an array's storage. One frame per level of nested calls holds the slots of the call in
// progress and its readers, reused from call to call: a reader is good until the body returns.

import type { FormulaError } from '../values/errors';
import { CALC, NA } from '../values/errors';
import { snapSum } from '../values/precision';
import type { ArrayValue, Scalar, Value } from '../values/value';
import { arrayOf, elementAt, isArray, isError, isReference, MOST_ELEMENTS, partOf } from '../values/value';
import type { Tally } from './criteria';
import type { Evaluator } from './evaluator';
import type { Family } from './families';
import { Families } from './families';
import type { Vector } from './search';
import { edge, heightOf, widthOf } from './search';
import type { Held } from './signature';

export class Frame {
    // The arguments as prepared and then as read, and what the body gets, one per parameter.
    public readonly held: Held[] = [];
    public readonly args: unknown[] = [];
    // Set by a reader that could not answer: the result of the call, whatever the body made of it.
    public failed: FormulaError | null = null;
    private readonly ctx: Evaluator;
    // What the criteria of the call in progress matched.
    public readonly matches = new Matches();
    public readonly tally: Tally = { count: 0, numbers: new Float64Array(8), found: 0, error: null };
    private readonly readers: Numbers[] = [];
    private readonly tables: Table[] = [];

    public constructor(ctx: Evaluator) {
        this.ctx = ctx;
    }

    public table(param: number): Table {
        return (this.tables[param] ??= new Table(this.ctx));
    }

    // The reader of the numbers of one parameter.
    public numbers(param: number): Numbers {
        return (this.readers[param] ??= new Numbers(this.ctx, this));
    }
}

// The cells that every criterion of a call accepts.
export class Matches {
    public count = 0;
}

// The numbers a family counts among the arguments of one parameter.
export class Numbers {
    private readonly ctx: Evaluator;
    private readonly frame: Frame;
    private from = 0;
    private to = 0;
    private family: Family = Families.Numbers;
    // How many cells count, once a walk has found out.
    private counted = -1;
    private snaps = true;
    private gathered: Float64Array = new Float64Array(8);

    public constructor(ctx: Evaluator, frame: Frame) {
        this.ctx = ctx;
        this.frame = frame;
    }

    // The arguments `from` up to `to` of the frame.
    public bind(from: number, to: number, family: Family, snaps: boolean): this {
        this.snaps = snaps;
        this.from = from;
        this.to = to;
        this.family = family;
        this.counted = -1;
        return this;
    }

    // Added number by number in written order. Of a family's numbers the sum is 0 when the last addition leaves
    // next to nothing.
    public sum(): number {
        const { walk } = this.start();
        const sum = walk.add();
        this.done();
        return this.snaps ? snapSum(sum, walk.before) : sum;
    }

    // How many cells count, a repeated one as often as it is written.
    public count(): number {
        if (this.counted >= 0) return this.counted;
        const { walk } = this.start();
        while (walk.next());
        return this.done();
    }

    public min(): number {
        const { walk } = this.start();
        let least = Number.POSITIVE_INFINITY;
        while (walk.next()) for (let i = walk.from; i < walk.to; i += 1) if (walk.num[i] < least) least = walk.num[i];
        this.done();
        return least;
    }

    public max(): number {
        const { walk } = this.start();
        let most = Number.NEGATIVE_INFINITY;
        while (walk.next()) for (let i = walk.from; i < walk.to; i += 1) if (walk.num[i] > most) most = walk.num[i];
        this.done();
        return most;
    }

    // Every number once per written cell, in written order: a copy that is the body's own.
    public list(): Float64Array {
        const { walk } = this.start();
        this.gathered = walk.gather(this.gathered);
        const count = this.done();
        if (this.frame.failed !== null || !this.ctx.recalc.room(count, MOST_ELEMENTS)) {
            return new Float64Array(0);
        }
        return this.gathered.slice(0, count);
    }

    public sorted(): Float64Array {
        return this.list().sort();
    }

    private start(): Evaluator {
        this.ctx.walk.start(this.frame.held, this.from, this.to, this.family);
        return this.ctx;
    }

    private done(): number {
        const { walk } = this.ctx;
        if (walk.error !== null) this.frame.failed = walk.error;
        this.counted = walk.count;
        return walk.count;
    }
}

// A range, an array or one value as a table: its size, a row or a column of it to search, and one value of it.
// Nothing is read until the body asks, and what it asks for is computed first.
export class Table {
    public rows = 1;
    public columns = 1;
    // How many areas the range has. The size, and everything but `area`, is of the first.
    public areas = 1;
    private readonly ctx: Evaluator;
    private value: Value = null;
    private piece: Table | null = null;

    public constructor(ctx: Evaluator) {
        this.ctx = ctx;
    }

    // What a table stands for, which the call wrapper asks of one that a body answered with.
    public static held(table: Table): Value {
        return table.value;
    }

    public over(value: Value): this {
        this.value = value;
        this.rows = heightOf(value);
        this.columns = widthOf(value);
        this.areas = 1;
        for (let area = isReference(value) ? value.next : null; area !== null; area = area.next) this.areas += 1;
        return this;
    }

    // One area of a range that a union made, from 0, as a table of its own.
    public area(index: number): Table | undefined {
        if (index === 0 && this.areas === 1) return this;
        let area = isReference(this.value) ? this.value : null;
        for (let skip = index; skip > 0 && area !== null; skip -= 1) area = area.next;
        return area === null ? undefined : this.spare().over(area.next === null ? area : { ...area, next: null });
    }

    public column(index: number): Vector {
        return edge(this.ctx, this.value, true, index);
    }

    public row(index: number): Vector {
        return edge(this.ctx, this.value, false, index);
    }

    // One value, by its row and column from 0: #N/A outside the table.
    public at(row: number, column: number): Scalar {
        const { ctx, value } = this;
        if (row < 0 || column < 0 || row >= this.rows || column >= this.columns) return NA;
        if (isReference(value)) {
            return ctx.recalc.valueOf(ctx.workbook.sheets[value.sheet], value.top + row, value.left + column);
        }
        if (isArray(value)) return ctx.first(elementAt(value, row, column));
        return typeof value !== 'object' || value === null || isError(value) ? value : null;
    }

    // A rectangle of the table, for a row that may answer with one. It is good until `part` is asked again.
    public part(top: number, left: number, rows: number, columns: number): Table {
        const { value } = this;
        const piece = this.spare();
        if (isReference(value)) {
            const corner = { top: value.top + top, left: value.left + left };
            return piece.over({
                ...value,
                ...corner,
                bottom: corner.top + rows - 1,
                right: corner.left + columns - 1,
                next: null,
            });
        }
        return piece.over(isArray(value) ? partOf(value, top, left, rows, columns) : value);
    }

    private spare(): Table {
        this.piece ??= new Table(this.ctx);
        return this.piece;
    }
}

// Where a body that builds an array gets it: asked of the pass before the array exists, and #CALC! over its bound.
export class Room {
    private readonly ctx: Evaluator;

    public constructor(ctx: Evaluator) {
        this.ctx = ctx;
    }

    // `first`, `first` + 1 and so on, down `rows` when there are several and else along `columns`.
    public series(first: number, rows: number, columns: number): Scalar | ArrayValue {
        const count = rows * columns;
        if (count === 1) return first;
        if (!this.ctx.recalc.room(count, MOST_ELEMENTS)) return CALC;
        const numbers = new Float64Array(count);
        for (let i = 0; i < count; i += 1) numbers[i] = first + i;
        return arrayOf(rows, columns, numbers);
    }
}
