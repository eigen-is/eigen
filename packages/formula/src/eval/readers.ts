// What a function's body gets in place of a range: a reader the call wrapper has prepared, so no body touches a
// cell, a column or an array's storage. One frame per level of nested calls holds the slots of the call in
// progress and its readers, reused from call to call: a reader is good until the body returns.

import type { FormulaError } from '../values/errors';
import { snapSum } from '../values/precision';
import { MOST_ELEMENTS } from '../values/value';
import type { Evaluator } from './evaluator';
import type { Family } from './families';
import { Families } from './families';
import type { Held } from './signature';

export class Frame {
    // The arguments as prepared and then as read, and what the body gets, one per parameter.
    public readonly held: Held[] = [];
    public readonly args: unknown[] = [];
    // Set by a reader that could not answer: the result of the call, whatever the body made of it.
    public failed: FormulaError | null = null;
    private readonly ctx: Evaluator;
    private readonly readers: Numbers[] = [];

    public constructor(ctx: Evaluator) {
        this.ctx = ctx;
    }

    // The reader of the numbers of one parameter.
    public numbers(param: number): Numbers {
        return (this.readers[param] ??= new Numbers(this.ctx, this));
    }
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
    private gathered: Float64Array = new Float64Array(8);

    public constructor(ctx: Evaluator, frame: Frame) {
        this.ctx = ctx;
        this.frame = frame;
    }

    // The arguments `from` up to `to` of the frame.
    public bind(from: number, to: number, family: Family): this {
        this.from = from;
        this.to = to;
        this.family = family;
        this.counted = -1;
        return this;
    }

    // Added number by number in written order, and 0 when the last addition leaves next to nothing.
    public sum(): number {
        const { walk } = this.start();
        const sum = walk.add();
        this.done();
        return snapSum(sum, walk.before);
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
