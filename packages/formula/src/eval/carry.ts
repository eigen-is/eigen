// What a pass found in the rows of a range from its top down, so a call whose range reaches further, as each
// formula of a running total does, computes, checks and walks only the rows below. Within a pass a settled cell
// keeps its value, so what one call found holds for every call that reads the same rows. The recalc's era moves
// with every pass and every loop that closes, and a carry of another era is started over.

import type { FormulaError } from '../values/errors';
import type { Reference } from '../values/value';
import type { Family } from './families';
import { Families } from './families';

// What a walk of the numbers answers: a count, a sum, the least and the most.
export const Answer = { Count: 0, Sum: 1, Least: 2, Most: 3 } as const;
export type Answer = (typeof Answer)[keyof typeof Answer];

// Each answer over no numbers, which the walk of the first rows starts from.
export const NOTHING: readonly number[] = [0, 0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

const SLOTS = 16;

export class Carry {
    // A range of the same sheet, top, left and right, the family and skips it is walked with, and its era.
    public area: Reference | null = null;
    public family: Family = Families.Numbers;
    public skips = 0;
    public era = -1;
    // Moves when the carry starts over, so a call that took it can tell whether a formula it computed meanwhile
    // took it for another range.
    public mark = 0;
    // The row the computed and checked rows end above, and the first error among them.
    public settled = 0;
    public error: FormulaError | null = null;
    // Per answer the row it ends above, its value there and the cells counted; of the sum, the sum before its last
    // addition, which the snap next to zero reads.
    public readonly ends = new Float64Array(4);
    public readonly values = new Float64Array(4);
    public readonly counts = new Float64Array(4);
    public before = 0;
}

export class Carries {
    private readonly slots = Array.from({ length: SLOTS }, () => new Carry());
    private marks = 0;

    // The carry of `area` walked by `family` past `skips` in `era`: one that knows rows down to its last at most,
    // or one started over that knows none.
    public of(area: Reference, family: Family, skips: number, era: number): Carry {
        const { sheet, top, left, right } = area;
        const carry = this.slots[(sheet * 7 + top * 31 + left * 17 + family.kinds * 3 + family.text) & (SLOTS - 1)];
        const held = carry.area;
        const same = held?.sheet === sheet && held.top === top && held.left === left && held.right === right;
        const walked = carry.family === family && carry.skips === skips && carry.settled <= area.bottom + 1;
        if (carry.era === era && same && walked) return carry;
        carry.area = area;
        carry.family = family;
        carry.skips = skips;
        carry.era = era;
        this.marks += 1;
        carry.mark = this.marks;
        carry.settled = top;
        carry.error = null;
        carry.ends.fill(top);
        return carry;
    }
}
