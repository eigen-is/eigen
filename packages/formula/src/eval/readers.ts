// What a function's body gets in place of a range: a reader the call wrapper has prepared, so no body touches a
// cell, a column or an array's storage. One frame per level of nested calls holds the slots of the call in
// progress and its readers, reused from call to call: a reader is good until the body returns. What aims a reader
// at its arguments is static, as `Table.over` is: the wrapper has the class, and a body only an instance, whose
// type has no member that reaches a cell the call does not name.

import type { FormulaError } from '../values/errors';
import { CALC, NA, NUM, VALUE } from '../values/errors';
import { snapSum } from '../values/precision';
import type { ArrayValue, Reference, Scalar, Value } from '../values/value';
import {
    arrayOf,
    elementAt,
    heightOf,
    isArray,
    isCell,
    isError,
    isReference,
    partOf,
    ValueType,
    widthOf,
} from '../values/value';
import { Book } from './book';
import { Tally } from './criteria';
import type { Evaluator } from './evaluator';
import type { Family } from './families';
import { Families } from './families';
import type { Vector } from './search';
import { edge } from './search';
import type { Held } from './signature';
import { add } from './sum';

export class Frame {
    // The arguments as prepared and then as read, and what the body gets, one per parameter.
    public readonly held: Held[] = [];
    public readonly args: unknown[] = [];
    // Set by a reader that could not answer: the result of the call, whatever the body made of it.
    public failed: FormulaError | null = null;
    // What the walk of the call in progress passes over, when another row picked the row that runs.
    public skips = 0;
    private readonly ctx: Evaluator;
    // What the criteria of the call in progress matched, and what its two ranges read side by side hold.
    public readonly matches = new Matches();
    public readonly tally = new Tally();
    public readonly pairs = new Pairs();
    private readonly readers: Numbers[] = [];
    private readonly tables: Table[] = [];
    private readonly lists: string[][] = [];
    private readonly numberLists: number[][] = [];
    private asked: Book | null = null;

    public constructor(ctx: Evaluator) {
        this.ctx = ctx;
    }

    public table(at: number): Table {
        const { tables } = this;
        while (tables.length <= at) tables.push(new Table(this.ctx));
        return tables[at];
    }

    // What the body of the call in progress may ask of the workbook: a book of this frame's own, so the formulas
    // that are computed while that body runs, a level deeper, aim another.
    public book(): Book {
        this.asked ??= new Book(this.ctx);
        return this.asked;
    }

    public texts(param: number): string[] {
        return (this.lists[param] ??= []);
    }

    public wholes(param: number): number[] {
        return (this.numberLists[param] ??= []);
    }

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
    // Whether the numbers are the ones the criteria of the call left beside their matches, and no argument's.
    private matched = false;
    // Whether the numbers are the products of the arguments, place by place.
    private multiplied = false;

    public constructor(ctx: Evaluator, frame: Frame) {
        this.ctx = ctx;
        this.frame = frame;
    }

    // The arguments `from` up to `to` of the frame, as a family counts them.
    public static bind(numbers: Numbers, from: number, to: number, family: Family, snaps: boolean): Numbers {
        numbers.snaps = snaps;
        numbers.from = from;
        numbers.to = to;
        numbers.family = family;
        numbers.counted = -1;
        numbers.matched = false;
        numbers.multiplied = false;
        return numbers;
    }

    // The arguments `from` up to `to` of the frame, which are of one size, multiplied place by place: what is no
    // number is 0. Their sum is the plain one.
    public static together(numbers: Numbers, from: number, to: number): Numbers {
        Numbers.bind(numbers, from, to, Families.Numbers, false).multiplied = true;
        return numbers;
    }

    // The numbers beside the cells that the criteria of the call accepted. Their sum is the plain one.
    public static beside(numbers: Numbers): Numbers {
        Numbers.bind(numbers, 0, 0, Families.Numbers, false).matched = true;
        return numbers;
    }

    // Added number by number in written order. Of a family's numbers the sum is 0 when the last addition leaves
    // next to nothing.
    public sum(): number {
        const { walk, recalc } = this.start();
        const sum = add(walk, recalc);
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

    // Every number in written order, one that is written many times over as often: a list of the body's own.
    public list(): Float64Array {
        const size = this.count();
        if (!this.ctx.recalc.room(size)) {
            this.frame.failed = CALC;
            return new Float64Array(0);
        }
        const list = new Float64Array(size);
        const { walk } = this.start();
        let at = 0;
        while (walk.next()) {
            const { num, from, to, reps } = walk;
            for (let row = 0; row < walk.rows; row += 1) {
                for (let i = from; i < to; i += 1) {
                    for (let times = reps === null ? 1 : reps[i]; times > 0; times -= 1) list[at++] = num[i];
                }
            }
        }
        this.done();
        return list;
    }

    // Whether `value` is one of the numbers.
    public holds(value: number): boolean {
        const { walk } = this.start();
        let found = false;
        while (walk.next()) for (let i = walk.from; i < walk.to; i += 1) found ||= walk.num[i] === value;
        this.done();
        return found;
    }

    private start(): Evaluator {
        const { walk } = this.ctx;
        walk.start(this.frame.held, this.from, this.to, this.family, this.frame.skips);
        if (this.matched) walk.hand(this.frame.tally.numbers, this.frame.tally.found);
        if (this.multiplied) walk.multiply();
        return this.ctx;
    }

    private done(): number {
        const { walk } = this.ctx;
        if (walk.error !== null) this.frame.failed = walk.error;
        this.counted = walk.count;
        return walk.count;
    }
}

// Two ranges or arrays of one size read side by side, place by place in written order and a range row by row:
// the numbers at the places where both hold one.
export class Pairs {
    public xs = new Float64Array(0);
    public ys = new Float64Array(0);
    private first = new Float64Array(0);
    private second = new Float64Array(0);

    // The error that keeps two arguments from being paired, in Excel's order: of one cell by itself, of unequal
    // sizes, of an array of references, and else the first error at the earliest place.
    public static over(ctx: Evaluator, pairs: Pairs, first: Value, second: Value): FormulaError | null {
        const lone = alone(ctx, first) ?? alone(ctx, second);
        if (lone !== null) return lone;
        const size = heightOf(first) * widthOf(first);
        if (heightOf(second) * widthOf(second) !== size) return NA;
        if ((isArray(first) && first.references) || (isArray(second) && second.references)) return NUM;
        if (isReference(first)) ctx.recalc.settleArea(first);
        if (isReference(second)) ctx.recalc.settleArea(second);
        // Past the last cell of both ranges every place is a blank, which pairs with nothing.
        const used = Math.max(placesOf(ctx, first), placesOf(ctx, second));
        // Two lists are made, and each may be as long as an array is.
        if (!ctx.recalc.room(used) || !ctx.recalc.spend(used)) return CALC;
        if (pairs.first.length < used) {
            pairs.first = new Float64Array(used);
            pairs.second = new Float64Array(used);
        }
        let count = 0;
        for (let place = 0; place < used; place += 1) {
            const x = placed(ctx, first, place);
            const y = placed(ctx, second, place);
            if (isError(x)) return x;
            if (isError(y)) return y;
            if (typeof x !== 'number' || typeof y !== 'number') continue;
            pairs.first[count] = x;
            pairs.second[count] = y;
            count += 1;
        }
        pairs.xs = pairs.first.subarray(0, count);
        pairs.ys = pairs.second.subarray(0, count);
        return null;
    }
}

// What keeps one cell that is an argument by itself from being paired: #VALUE! when it holds nothing, and the
// error it holds. Null for any other argument.
function alone(ctx: Evaluator, value: Value): FormulaError | null {
    if (!isReference(value) || !isCell(value)) return null;
    const held = ctx.first(value);
    return held === null ? VALUE : isError(held) ? held : null;
}

// How many places of an argument, counted row by row, can hold a value: of a range, up to the last row that a
// column of it reaches.
function placesOf(ctx: Evaluator, value: Value): number {
    if (!isReference(value)) return heightOf(value) * widthOf(value);
    const { columns } = ctx.workbook.sheets[value.sheet];
    let rows = 0;
    for (let c = value.left; c <= value.right && c < columns.length; c += 1) {
        rows = Math.max(rows, Math.min(value.bottom + 1, columns[c].length) - value.top);
    }
    return rows * widthOf(value);
}

// The value at one place of an argument, counted row by row.
function placed(ctx: Evaluator, value: Value, place: number): Scalar | Reference {
    if (isArray(value)) return elementAt(value, Math.floor(place / value.columns), place % value.columns);
    if (!isReference(value)) return value;
    const width = widthOf(value);
    const { columns } = ctx.workbook.sheets[value.sheet];
    const c = value.left + (place % width);
    return c < columns.length ? ctx.workbook.value(columns[c], value.top + Math.floor(place / width)) : null;
}

// A range, an array or one value as a table: its size, a row or a column of it to search, and one value of it.
// Nothing is read until the body asks, and what it asks for is computed first.
export class Table {
    public readonly type = ValueType.Table;
    public rows = 1;
    public columns = 1;
    // How many areas the range has. The size, and everything but `area`, is of the first.
    public areas = 1;
    // Whether what was written is a reference: an array is none, whatever its elements are.
    public reference = false;
    private readonly ctx: Evaluator;
    private value: Value = null;
    private piece: Table | null = null;

    public constructor(ctx: Evaluator) {
        this.ctx = ctx;
    }

    // What a table stands for.
    public static held(table: Table): Value {
        return table.value;
    }

    // Makes `table` the table of what an argument was evaluated to.
    public static over(table: Table, value: Value): Table {
        return table.aim(value);
    }

    // One area of a range that a union made, from 0, as a table of its own.
    public area(index: number): Table | undefined {
        if (index === 0 && this.areas === 1) return this;
        let area = isReference(this.value) ? this.value : null;
        for (let skip = index; skip > 0 && area !== null; skip -= 1) area = area.next;
        return area === null ? undefined : this.spare().aim(area.next === null ? area : { ...area, next: null });
    }

    public column(index: number): Vector {
        return edge(this.ctx, this.value, true, index);
    }

    public row(index: number): Vector {
        return edge(this.ctx, this.value, false, index);
    }

    // One value, by its row and column from 0: #N/A outside the table, which is as large as what it stands for.
    public at(row: number, column: number): Scalar {
        const { ctx, value } = this;
        if (row < 0 || column < 0 || row >= heightOf(value) || column >= widthOf(value)) return NA;
        if (isReference(value)) {
            return ctx.recalc.valueOf(ctx.workbook.sheets[value.sheet], value.top + row, value.left + column);
        }
        if (isArray(value)) return ctx.first(elementAt(value, row, column));
        return value;
    }

    // A rectangle of the table, for a row that may answer with one: a table of #N/A when it does not lie inside the
    // table. It is good until `part` is asked again.
    public part(top: number, left: number, rows: number, columns: number): Table {
        const { value } = this;
        const piece = this.spare();
        const inside = top >= 0 && left >= 0 && rows > 0 && columns > 0;
        if (!inside || top + rows > heightOf(value) || left + columns > widthOf(value)) return piece.aim(NA);
        if (isReference(value)) {
            const first = value.top + top;
            const start = value.left + left;
            const { type, sheet } = value;
            return piece.aim({
                type,
                sheet,
                top: first,
                left: start,
                bottom: first + rows - 1,
                right: start + columns - 1,
                next: null,
            });
        }
        return piece.aim(isArray(value) ? partOf(value, top, left, rows, columns) : value);
    }

    private aim(value: Value): this {
        this.value = value;
        this.areas = 1;
        this.reference = isReference(value);
        this.rows = heightOf(value);
        this.columns = widthOf(value);
        for (let area = isReference(value) ? value.next : null; area !== null; area = area.next) this.areas += 1;
        return this;
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
        if (!this.ctx.recalc.room(count)) return CALC;
        const numbers = new Float64Array(count);
        for (let i = 0; i < count; i += 1) numbers[i] = first + i;
        return arrayOf(rows, columns, numbers);
    }
}
