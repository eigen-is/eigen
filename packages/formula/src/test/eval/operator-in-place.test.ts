import { describe, expect, test } from 'bun:test';
import type { Literal } from '../../index';
import { engineOf, valueAt } from '../recalc/support';

const ALL = Number.POSITIVE_INFINITY;
const ROWS = 20_000;

// What a run costs in the two things a copy of a range into an array of values costs: the elements pushed onto
// arrays, and the texts upper-cased.
function counted(run: () => void): { pushed: number; uppered: number } {
    const push = Array.prototype.push;
    const upper = String.prototype.toUpperCase;
    const counts = { pushed: 0, uppered: 0 };
    Array.prototype.push = function counting(...items) {
        counts.pushed += items.length;
        return push.apply(this, items);
    };
    String.prototype.toUpperCase = function counting() {
        counts.uppered += 1;
        return upper.call(this);
    };
    try {
        run();
    } finally {
        Array.prototype.push = push;
        String.prototype.toUpperCase = upper;
    }
    return counts;
}

// Three columns of 20,000 rows: a text key that repeats every 50 rows, a second every 7, and a number.
function lookupTable(): Record<string, Literal> {
    const cells: Record<string, Literal> = {};
    for (let row = 1; row <= ROWS; row += 1) {
        cells[`A${row}`] = `Key ${row % 50}`;
        cells[`B${row}`] = `part ${row % 7}`;
        cells[`C${row}`] = row;
    }
    return cells;
}

describe('an operator reads a range where it lies', () => {
    test('arithmetic over 20,000 rows makes no array of values: its numbers are read from the column', () => {
        const engine = engineOf({ s1: { ...lookupTable(), E1: `=SUM(C1:C${ROWS}*2)`, E2: `=SUM(-C1:C${ROWS})` } });
        const { pushed } = counted(() => engine.recalc(ALL));
        expect(valueAt(engine, 'E1')).toBe(ROWS * (ROWS + 1));
        expect(valueAt(engine, 'E2')).toBe((-ROWS * (ROWS + 1)) / 2);
        expect(pushed).toBeLessThan(ROWS / 10);
    });

    test('a comparison of 20,000 texts upper-cases none of them: the string table holds their keys', () => {
        const engine = engineOf({
            s1: {
                ...lookupTable(),
                E1: 'KEY 49',
                E2: 'PART 3',
                E3: `=MATCH(1,(A1:A${ROWS}=E1)*(B1:B${ROWS}=E2),0)`,
                E4: `=SUMPRODUCT((A1:A${ROWS}=E1)*(B1:B${ROWS}=E2)*C1:C${ROWS})`,
            },
        });
        const { pushed, uppered } = counted(() => engine.recalc(ALL));
        // Row 199 is the first that is 49 past a multiple of 50 and 3 past a multiple of 7, and every 350th after.
        expect(valueAt(engine, 'E3')).toBe(199);
        let sum = 0;
        for (let row = 199; row <= ROWS; row += 350) sum += row;
        expect(valueAt(engine, 'E4')).toBe(sum);
        expect(uppered).toBeLessThan(100);
        // Each of the four comparisons stores its 20,000 answers, and nothing else is as long as the range.
        expect(pushed).toBeLessThan(4 * ROWS + ROWS / 10);
    });

    test('an ordering of 20,000 texts reads their keys from the string table too', () => {
        const engine = engineOf({ s1: { ...lookupTable(), E1: 'key 25', E3: `=SUMPRODUCT(--(A1:A${ROWS}<E1))` } });
        const { uppered } = counted(() => engine.recalc(ALL));
        // Of every 50 keys, 18 sort below "KEY 25": 0, 1, 10 to 19, 2 and 20 to 24.
        expect(valueAt(engine, 'E3')).toBe((ROWS / 50) * 18);
        expect(uppered).toBeLessThan(100);
    });
});
