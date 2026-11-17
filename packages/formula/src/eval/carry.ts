// What a pass found in the rows of a range from its top down, so a call whose range reaches further, as each
// formula of a running total does, computes, checks and walks only the rows below. Within a pass a settled cell
// keeps its value, so what one call found holds for every call that reads the same rows. The recalc's era moves
// with every pass and every loop that closes, and a carry of another era is started over.

import type { FormulaError } from '../values/errors';
import type { Reference } from '../values/value';
import type { Family } from './families';

// What a walk of the numbers answers: a count, a sum, the least and the most.
export const Answer = { Count: 0, Sum: 1, Least: 2, Most: 3 } as const;
export type Answer = (typeof Answer)[keyof typeof Answer];

// Each answer over no numbers, which the walk of the first rows starts from.
export const NOTHING: readonly number[] = [0, 0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

const SLOTS = 16;

export class Carry {
    // The range but for its bottom, what of the family a walk of a range reads, the skips, and the era.
    public sheet = -1;
    public top = 0;
    public left = 0;
    public right = 0;
    public walks = 0;
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
    // or one started over that knows none. Of a range a walk reads only the kinds a family counts and whether an
    // error is its answer.
    public of(area: Reference, family: Family, skips: number, era: number): Carry {
        const { sheet, top, left, right } = area;
        const { kinds, errors } = family;
        const walks = kinds | (errors << 8);
        const carry = this.slots[(sheet * 7 + top * 31 + left * 17 + kinds * 3 + errors * 5) & (SLOTS - 1)];
        const same = carry.top === top && carry.left === left && carry.right === right && carry.sheet === sheet;
        const walked = carry.walks === walks && carry.skips === skips && carry.settled <= area.bottom + 1;
        if (carry.era === era && same && walked) return carry;
        carry.sheet = sheet;
        carry.top = top;
        carry.left = left;
        carry.right = right;
        carry.walks = walks;
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
