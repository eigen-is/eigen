// Filter-by-condition evaluator. A condition stored on a column's FilterEntry
// (`byCondition`) is evaluated against the column's cells on Confirm and the
// non-matching rows become that column's `rowhidden` set — flowing through the
// same saveFilter merge as by-values. Semantics pinned here: numeric compare
// when both sides parse as numbers, case-insensitive text (Google behavior),
// day-granularity dates on ct.t === 'd' cells, negatives keep blanks visible,
// incomplete input is a no-op (never "hide everything").

import { describe, expect, test } from 'bun:test';
import { genarate } from '../../../engine/format';
import type { Context } from '../../../state/context';
import { en } from '../../../state/locale/en';
import {
    buildFilterConditionMatcher,
    clearFilter,
    FILTER_CONDITION_ITEMS,
    getFilterConditionHiddenRows,
    saveFilter,
} from '../../../state/modules/filter';
import type { Cell, FilterCondition, FilterConditionName } from '../../../state/types';
import { contextFactory } from '../factories/context';

function text(v: string): Cell {
    return { v, m: v, ct: { fa: 'General', t: 's' } };
}

function num(v: number): Cell {
    return { v, m: String(v), ct: { fa: 'General', t: 'n' } };
}

function date(iso: string): Cell {
    const [m, ct, v] = genarate(iso);
    expect(ct.t).toBe('d');
    return { v, m: `${m}`, ct };
}

function cond(conditionName: FilterConditionName, ...values: string[]): FilterCondition {
    return { conditionName, values };
}

const BLANKS: (Cell | null)[] = [null, {}, { v: '' }, { v: '  ' }];

describe('buildFilterConditionMatcher', () => {
    test('isEmpty matches missing, null, empty and whitespace-only cells', () => {
        for (const cell of BLANKS) {
            expect(buildFilterConditionMatcher(cond('isEmpty'))(cell)).toBe(true);
        }
        expect(buildFilterConditionMatcher(cond('isEmpty'))(text('a'))).toBe(false);
        expect(buildFilterConditionMatcher(cond('isEmpty'))(num(0))).toBe(false);
    });

    test('isNotEmpty is the exact complement of isEmpty', () => {
        for (const cell of BLANKS) {
            expect(buildFilterConditionMatcher(cond('isNotEmpty'))(cell)).toBe(false);
        }
        expect(buildFilterConditionMatcher(cond('isNotEmpty'))(num(0))).toBe(true);
    });

    test('textContains is case-insensitive (Google behavior)', () => {
        expect(buildFilterConditionMatcher(cond('textContains', 'apple'))(text('Apple Pie'))).toBe(true);
        expect(buildFilterConditionMatcher(cond('textContains', 'APPLE'))(text('apple pie'))).toBe(true);
        expect(buildFilterConditionMatcher(cond('textContains', 'apple'))(text('cherry'))).toBe(false);
    });

    test('text conditions compare the display string, not the raw value', () => {
        // 50% renders as m '50%' over raw v 0.5
        const percent: Cell = { v: 0.5, m: '50%', ct: { fa: '0%', t: 'n' } };
        expect(buildFilterConditionMatcher(cond('textContains', '50%'))(percent)).toBe(true);
        expect(buildFilterConditionMatcher(cond('textContains', '0.5'))(percent)).toBe(false);
    });

    test('textNotContains keeps blank cells visible', () => {
        for (const cell of BLANKS) {
            expect(buildFilterConditionMatcher(cond('textNotContains', 'apple'))(cell)).toBe(true);
        }
        expect(buildFilterConditionMatcher(cond('textNotContains', 'apple'))(text('Apple'))).toBe(false);
        expect(buildFilterConditionMatcher(cond('textNotContains', 'apple'))(text('cherry'))).toBe(true);
    });

    test('textStartsWith and textEndsWith are case-insensitive', () => {
        expect(buildFilterConditionMatcher(cond('textStartsWith', 'app'))(text('Apple Pie'))).toBe(true);
        expect(buildFilterConditionMatcher(cond('textStartsWith', 'pie'))(text('Apple Pie'))).toBe(false);
        expect(buildFilterConditionMatcher(cond('textEndsWith', 'PIE'))(text('Apple Pie'))).toBe(true);
        expect(buildFilterConditionMatcher(cond('textEndsWith', 'app'))(text('Apple Pie'))).toBe(false);
    });

    test('textEquals matches the whole display string case-insensitively', () => {
        expect(buildFilterConditionMatcher(cond('textEquals', 'apple'))(text('Apple'))).toBe(true);
        expect(buildFilterConditionMatcher(cond('textEquals', 'apple'))(text('Apple Pie'))).toBe(false);
    });

    test('greaterThan compares numerically when both sides parse as numbers', () => {
        // lexicographic '9' > '10' would be true; numeric compare must win
        expect(buildFilterConditionMatcher(cond('greaterThan', '10'))(num(9))).toBe(false);
        expect(buildFilterConditionMatcher(cond('greaterThan', '10'))(num(11))).toBe(true);
        expect(buildFilterConditionMatcher(cond('greaterThan', '10'))(num(10))).toBe(false);
    });

    test('greaterThan falls back to case-insensitive string compare for non-numeric sides', () => {
        expect(buildFilterConditionMatcher(cond('greaterThan', 'Apple'))(text('banana'))).toBe(true);
        expect(buildFilterConditionMatcher(cond('greaterThan', 'banana'))(text('Apple'))).toBe(false);
    });

    test('greaterThanOrEqual / lessThan / lessThanOrEqual respect the boundary', () => {
        expect(buildFilterConditionMatcher(cond('greaterThanOrEqual', '10'))(num(10))).toBe(true);
        expect(buildFilterConditionMatcher(cond('greaterThanOrEqual', '10'))(num(9))).toBe(false);
        expect(buildFilterConditionMatcher(cond('lessThan', '10'))(num(9))).toBe(true);
        expect(buildFilterConditionMatcher(cond('lessThan', '10'))(num(10))).toBe(false);
        expect(buildFilterConditionMatcher(cond('lessThanOrEqual', '10'))(num(10))).toBe(true);
        expect(buildFilterConditionMatcher(cond('lessThanOrEqual', '10'))(num(11))).toBe(false);
    });

    test('equal matches a number cell against an equivalent numeric string', () => {
        expect(buildFilterConditionMatcher(cond('equal', '5'))(num(5))).toBe(true);
        expect(buildFilterConditionMatcher(cond('equal', '5.0'))(num(5))).toBe(true);
        expect(buildFilterConditionMatcher(cond('equal', '6'))(num(5))).toBe(false);
    });

    test('equal vs notEqual on mixed types: a text cell never equals a numeric input', () => {
        expect(buildFilterConditionMatcher(cond('equal', '5'))(text('abc'))).toBe(false);
        expect(buildFilterConditionMatcher(cond('notEqual', '5'))(text('abc'))).toBe(true);
        expect(buildFilterConditionMatcher(cond('equal', 'abc'))(text('ABC'))).toBe(true);
        expect(buildFilterConditionMatcher(cond('notEqual', 'abc'))(text('ABC'))).toBe(false);
    });

    test('notEqual keeps blank cells visible', () => {
        for (const cell of BLANKS) {
            expect(buildFilterConditionMatcher(cond('notEqual', '5'))(cell)).toBe(true);
        }
    });

    test('between bounds are inclusive', () => {
        expect(buildFilterConditionMatcher(cond('between', '5', '10'))(num(5))).toBe(true);
        expect(buildFilterConditionMatcher(cond('between', '5', '10'))(num(10))).toBe(true);
        expect(buildFilterConditionMatcher(cond('between', '5', '10'))(num(7))).toBe(true);
        expect(buildFilterConditionMatcher(cond('between', '5', '10'))(num(4))).toBe(false);
        expect(buildFilterConditionMatcher(cond('between', '5', '10'))(num(11))).toBe(false);
    });

    test('between normalizes reversed bounds', () => {
        expect(buildFilterConditionMatcher(cond('between', '10', '5'))(num(7))).toBe(true);
    });

    test('notBetween is the complement of between and keeps blanks visible', () => {
        expect(buildFilterConditionMatcher(cond('notBetween', '5', '10'))(num(7))).toBe(false);
        expect(buildFilterConditionMatcher(cond('notBetween', '5', '10'))(num(11))).toBe(true);
        for (const cell of BLANKS) {
            expect(buildFilterConditionMatcher(cond('notBetween', '5', '10'))(cell)).toBe(true);
        }
    });

    test('dateEqual matches same-day date cells only', () => {
        expect(buildFilterConditionMatcher(cond('dateEqual', '2026-06-11'))(date('2026-06-11'))).toBe(true);
        expect(buildFilterConditionMatcher(cond('dateEqual', '2026-06-11'))(date('2026-06-12'))).toBe(false);
    });

    test('dateBefore and dateAfter compare at day granularity', () => {
        expect(buildFilterConditionMatcher(cond('dateBefore', '2026-06-11'))(date('2026-06-10'))).toBe(true);
        expect(buildFilterConditionMatcher(cond('dateBefore', '2026-06-11'))(date('2026-06-11'))).toBe(false);
        expect(buildFilterConditionMatcher(cond('dateAfter', '2026-06-11'))(date('2026-06-12'))).toBe(true);
        expect(buildFilterConditionMatcher(cond('dateAfter', '2026-06-11'))(date('2026-06-11'))).toBe(false);
    });

    test('date conditions never match non-date cells', () => {
        expect(buildFilterConditionMatcher(cond('dateEqual', '2026-06-11'))(text('2026-06-11'))).toBe(false);
        expect(buildFilterConditionMatcher(cond('dateBefore', '2026-06-11'))(num(45000))).toBe(false);
        expect(buildFilterConditionMatcher(cond('dateAfter', '2026-06-11'))(null)).toBe(false);
    });

    test('unparseable date input is a no-op: every cell matches', () => {
        expect(buildFilterConditionMatcher(cond('dateEqual', 'not a date'))(date('2026-06-11'))).toBe(true);
        expect(buildFilterConditionMatcher(cond('dateBefore', 'garbage'))(text('x'))).toBe(true);
    });

    test('blank required input is a no-op: every cell matches', () => {
        expect(buildFilterConditionMatcher(cond('textContains', ''))(text('anything'))).toBe(true);
        expect(buildFilterConditionMatcher(cond('greaterThan', ' '))(num(1))).toBe(true);
        expect(buildFilterConditionMatcher(cond('between', '5', ''))(num(7))).toBe(true);
    });

    test('positive conditions never match blank cells', () => {
        for (const cell of BLANKS) {
            expect(buildFilterConditionMatcher(cond('textContains', 'a'))(cell)).toBe(false);
            expect(buildFilterConditionMatcher(cond('greaterThan', '0'))(cell)).toBe(false);
            expect(buildFilterConditionMatcher(cond('equal', ''.padEnd(1, '0')))(cell)).toBe(false);
            expect(buildFilterConditionMatcher(cond('between', '0', '9'))(cell)).toBe(false);
        }
    });
});

describe('FILTER_CONDITION_ITEMS', () => {
    test('lists all 18 conditions with existing locale labels and sane arity', () => {
        expect(FILTER_CONDITION_ITEMS).toHaveLength(18);
        expect(new Set(FILTER_CONDITION_ITEMS.map((i) => i.name)).size).toBe(18);
        for (const item of FILTER_CONDITION_ITEMS) {
            expect(typeof en.filter[item.localeKey]).toBe('string');
            expect([0, 1, 2]).toContain(item.arity);
        }
        expect(FILTER_CONDITION_ITEMS.find((i) => i.name === 'isEmpty')?.arity).toBe(0);
        expect(FILTER_CONDITION_ITEMS.find((i) => i.name === 'textContains')?.arity).toBe(1);
        expect(FILTER_CONDITION_ITEMS.find((i) => i.name === 'between')?.arity).toBe(2);
        expect(FILTER_CONDITION_ITEMS.find((i) => i.name === 'notBetween')?.arity).toBe(2);
    });
});

// Filter range: header on row 0, data on rows 1-4. Column 0 numeric, column 1 text.
function filterContext(): Context {
    return contextFactory({
        filter: {},
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                data: [
                    [text('Amount'), text('Name'), null, null],
                    [num(5), text('Alice'), null, null],
                    [num(15), text('Bob'), null, null],
                    [num(25), text('Carol'), null, null],
                    [null, text('Dave'), null, null],
                ],
                order: 0,
                row: 5,
                column: 4,
            },
        ],
    }) as Context;
}

describe('getFilterConditionHiddenRows', () => {
    test('returns the non-matching rows of the column as the hidden set', () => {
        const ctx = filterContext();
        const hidden = getFilterConditionHiddenRows(ctx, 0, 0, 4, 0, cond('greaterThan', '10'));
        // rows 1 (5) and 4 (blank) fail; rows 2 (15) and 3 (25) match
        expect(hidden).toEqual({ 1: 0, 4: 0 });
    });

    test('skips rows already hidden by other columns', () => {
        const ctx = filterContext();
        // column 1 filter already hid row 2
        ctx.filter[1] = {
            rowhidden: { 2: 0 },
            optionstate: true,
            str: 0,
            edr: 4,
            cindex: 1,
            stc: 0,
            edc: 1,
        };
        const hidden = getFilterConditionHiddenRows(ctx, 0, 0, 4, 0, cond('greaterThan', '10'));
        expect(hidden).toEqual({ 1: 0, 4: 0 });
        expect(hidden[2]).toBeUndefined();
    });
});

describe('saveFilter with a condition', () => {
    test('merges condition-hidden rows into config.rowhidden and persists byCondition on the sheet', () => {
        const ctx = filterContext();
        const byCondition = cond('greaterThan', '10');
        const hidden = getFilterConditionHiddenRows(ctx, 0, 0, 4, 0, byCondition);
        saveFilter(ctx, true, hidden, byCondition, 0, 4, 0, 0, 1);

        expect(ctx.config.rowhidden).toEqual({ 1: 0, 4: 0 });
        expect(ctx.sheets[0].config?.rowhidden).toEqual({ 1: 0, 4: 0 });
        expect(ctx.filter[0]?.byCondition).toEqual(byCondition);
        expect(ctx.sheets[0].filter?.[0]?.byCondition).toEqual(byCondition);
        expect(ctx.filter[0]?.optionstate).toBe(true);
    });

    test('coexists with another column filter via the otherHiddenRows merge', () => {
        const ctx = filterContext();
        // column 1 by-values filter hides row 3
        saveFilter(ctx, true, { 3: 0 }, undefined, 0, 4, 1, 0, 1);
        const byCondition = cond('greaterThan', '10');
        const hidden = getFilterConditionHiddenRows(ctx, 0, 0, 4, 0, byCondition);
        saveFilter(ctx, true, hidden, byCondition, 0, 4, 0, 0, 1);

        expect(ctx.config.rowhidden).toEqual({ 1: 0, 3: 0, 4: 0 });
        expect(ctx.sheets[0].filter?.[1]?.byCondition).toBeUndefined();
        expect(ctx.sheets[0].filter?.[0]?.byCondition).toEqual(byCondition);
    });

    test('clearFilter removes the condition entry and unhides its rows', () => {
        const ctx = filterContext();
        const byCondition = cond('greaterThan', '10');
        const hidden = getFilterConditionHiddenRows(ctx, 0, 0, 4, 0, byCondition);
        saveFilter(ctx, true, hidden, byCondition, 0, 4, 0, 0, 1);

        clearFilter(ctx);
        expect(ctx.config.rowhidden).toEqual({});
        expect(ctx.filter).toEqual({});
        expect(ctx.sheets[0].filter).toBeUndefined();
    });
});
