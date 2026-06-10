// Filter-by-condition evaluator. A condition stored on a column's FilterEntry
// (`byCondition`) is evaluated against the column's cells on Confirm and the
// non-matching rows become that column's `rowhidden` set — flowing through the
// same saveFilter merge as by-values. Semantics pinned here: numeric compare
// when both sides parse as numbers, case-insensitive text (Google behavior),
// day-granularity dates on ct.t === 'd' cells, negatives keep blanks visible,
// incomplete input is a no-op (never "hide everything").

import { describe, expect, test } from 'bun:test';
import { genarate } from '../../../engine/format';
import type { Context } from '../../context';
import { en } from '../../locale/en';
import {
    clearFilter,
    FILTER_CONDITION_ITEMS,
    getFilterConditionHiddenRows,
    matchesFilterCondition,
    saveFilter,
} from '../../modules/filter';
import type { Cell, FilterCondition, FilterConditionName } from '../../types';
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

describe('matchesFilterCondition', () => {
    test('isEmpty matches missing, null, empty and whitespace-only cells', () => {
        for (const cell of BLANKS) {
            expect(matchesFilterCondition(cell, cond('isEmpty'))).toBe(true);
        }
        expect(matchesFilterCondition(text('a'), cond('isEmpty'))).toBe(false);
        expect(matchesFilterCondition(num(0), cond('isEmpty'))).toBe(false);
    });

    test('isNotEmpty is the exact complement of isEmpty', () => {
        for (const cell of BLANKS) {
            expect(matchesFilterCondition(cell, cond('isNotEmpty'))).toBe(false);
        }
        expect(matchesFilterCondition(num(0), cond('isNotEmpty'))).toBe(true);
    });

    test('textContains is case-insensitive (Google behavior)', () => {
        expect(matchesFilterCondition(text('Apple Pie'), cond('textContains', 'apple'))).toBe(true);
        expect(matchesFilterCondition(text('apple pie'), cond('textContains', 'APPLE'))).toBe(true);
        expect(matchesFilterCondition(text('cherry'), cond('textContains', 'apple'))).toBe(false);
    });

    test('text conditions compare the display string, not the raw value', () => {
        // 50% renders as m '50%' over raw v 0.5
        const percent: Cell = { v: 0.5, m: '50%', ct: { fa: '0%', t: 'n' } };
        expect(matchesFilterCondition(percent, cond('textContains', '50%'))).toBe(true);
        expect(matchesFilterCondition(percent, cond('textContains', '0.5'))).toBe(false);
    });

    test('textNotContains keeps blank cells visible', () => {
        for (const cell of BLANKS) {
            expect(matchesFilterCondition(cell, cond('textNotContains', 'apple'))).toBe(true);
        }
        expect(matchesFilterCondition(text('Apple'), cond('textNotContains', 'apple'))).toBe(false);
        expect(matchesFilterCondition(text('cherry'), cond('textNotContains', 'apple'))).toBe(true);
    });

    test('textStartsWith and textEndsWith are case-insensitive', () => {
        expect(matchesFilterCondition(text('Apple Pie'), cond('textStartsWith', 'app'))).toBe(true);
        expect(matchesFilterCondition(text('Apple Pie'), cond('textStartsWith', 'pie'))).toBe(false);
        expect(matchesFilterCondition(text('Apple Pie'), cond('textEndsWith', 'PIE'))).toBe(true);
        expect(matchesFilterCondition(text('Apple Pie'), cond('textEndsWith', 'app'))).toBe(false);
    });

    test('textEquals matches the whole display string case-insensitively', () => {
        expect(matchesFilterCondition(text('Apple'), cond('textEquals', 'apple'))).toBe(true);
        expect(matchesFilterCondition(text('Apple Pie'), cond('textEquals', 'apple'))).toBe(false);
    });

    test('greaterThan compares numerically when both sides parse as numbers', () => {
        // lexicographic '9' > '10' would be true; numeric compare must win
        expect(matchesFilterCondition(num(9), cond('greaterThan', '10'))).toBe(false);
        expect(matchesFilterCondition(num(11), cond('greaterThan', '10'))).toBe(true);
        expect(matchesFilterCondition(num(10), cond('greaterThan', '10'))).toBe(false);
    });

    test('greaterThan falls back to case-insensitive string compare for non-numeric sides', () => {
        expect(matchesFilterCondition(text('banana'), cond('greaterThan', 'Apple'))).toBe(true);
        expect(matchesFilterCondition(text('Apple'), cond('greaterThan', 'banana'))).toBe(false);
    });

    test('greaterThanOrEqual / lessThan / lessThanOrEqual respect the boundary', () => {
        expect(matchesFilterCondition(num(10), cond('greaterThanOrEqual', '10'))).toBe(true);
        expect(matchesFilterCondition(num(9), cond('greaterThanOrEqual', '10'))).toBe(false);
        expect(matchesFilterCondition(num(9), cond('lessThan', '10'))).toBe(true);
        expect(matchesFilterCondition(num(10), cond('lessThan', '10'))).toBe(false);
        expect(matchesFilterCondition(num(10), cond('lessThanOrEqual', '10'))).toBe(true);
        expect(matchesFilterCondition(num(11), cond('lessThanOrEqual', '10'))).toBe(false);
    });

    test('equal matches a number cell against an equivalent numeric string', () => {
        expect(matchesFilterCondition(num(5), cond('equal', '5'))).toBe(true);
        expect(matchesFilterCondition(num(5), cond('equal', '5.0'))).toBe(true);
        expect(matchesFilterCondition(num(5), cond('equal', '6'))).toBe(false);
    });

    test('equal vs notEqual on mixed types: a text cell never equals a numeric input', () => {
        expect(matchesFilterCondition(text('abc'), cond('equal', '5'))).toBe(false);
        expect(matchesFilterCondition(text('abc'), cond('notEqual', '5'))).toBe(true);
        expect(matchesFilterCondition(text('ABC'), cond('equal', 'abc'))).toBe(true);
        expect(matchesFilterCondition(text('ABC'), cond('notEqual', 'abc'))).toBe(false);
    });

    test('notEqual keeps blank cells visible', () => {
        for (const cell of BLANKS) {
            expect(matchesFilterCondition(cell, cond('notEqual', '5'))).toBe(true);
        }
    });

    test('between bounds are inclusive', () => {
        expect(matchesFilterCondition(num(5), cond('between', '5', '10'))).toBe(true);
        expect(matchesFilterCondition(num(10), cond('between', '5', '10'))).toBe(true);
        expect(matchesFilterCondition(num(7), cond('between', '5', '10'))).toBe(true);
        expect(matchesFilterCondition(num(4), cond('between', '5', '10'))).toBe(false);
        expect(matchesFilterCondition(num(11), cond('between', '5', '10'))).toBe(false);
    });

    test('between normalizes reversed bounds', () => {
        expect(matchesFilterCondition(num(7), cond('between', '10', '5'))).toBe(true);
    });

    test('notBetween is the complement of between and keeps blanks visible', () => {
        expect(matchesFilterCondition(num(7), cond('notBetween', '5', '10'))).toBe(false);
        expect(matchesFilterCondition(num(11), cond('notBetween', '5', '10'))).toBe(true);
        for (const cell of BLANKS) {
            expect(matchesFilterCondition(cell, cond('notBetween', '5', '10'))).toBe(true);
        }
    });

    test('dateEqual matches same-day date cells only', () => {
        expect(matchesFilterCondition(date('2026-06-11'), cond('dateEqual', '2026-06-11'))).toBe(true);
        expect(matchesFilterCondition(date('2026-06-12'), cond('dateEqual', '2026-06-11'))).toBe(false);
    });

    test('dateBefore and dateAfter compare at day granularity', () => {
        expect(matchesFilterCondition(date('2026-06-10'), cond('dateBefore', '2026-06-11'))).toBe(true);
        expect(matchesFilterCondition(date('2026-06-11'), cond('dateBefore', '2026-06-11'))).toBe(false);
        expect(matchesFilterCondition(date('2026-06-12'), cond('dateAfter', '2026-06-11'))).toBe(true);
        expect(matchesFilterCondition(date('2026-06-11'), cond('dateAfter', '2026-06-11'))).toBe(false);
    });

    test('date conditions never match non-date cells', () => {
        expect(matchesFilterCondition(text('2026-06-11'), cond('dateEqual', '2026-06-11'))).toBe(false);
        expect(matchesFilterCondition(num(45000), cond('dateBefore', '2026-06-11'))).toBe(false);
        expect(matchesFilterCondition(null, cond('dateAfter', '2026-06-11'))).toBe(false);
    });

    test('unparseable date input is a no-op: every cell matches', () => {
        expect(matchesFilterCondition(date('2026-06-11'), cond('dateEqual', 'not a date'))).toBe(true);
        expect(matchesFilterCondition(text('x'), cond('dateBefore', 'garbage'))).toBe(true);
    });

    test('blank required input is a no-op: every cell matches', () => {
        expect(matchesFilterCondition(text('anything'), cond('textContains', ''))).toBe(true);
        expect(matchesFilterCondition(num(1), cond('greaterThan', ' '))).toBe(true);
        expect(matchesFilterCondition(num(7), cond('between', '5', ''))).toBe(true);
    });

    test('positive conditions never match blank cells', () => {
        for (const cell of BLANKS) {
            expect(matchesFilterCondition(cell, cond('textContains', 'a'))).toBe(false);
            expect(matchesFilterCondition(cell, cond('greaterThan', '0'))).toBe(false);
            expect(matchesFilterCondition(cell, cond('equal', ''.padEnd(1, '0')))).toBe(false);
            expect(matchesFilterCondition(cell, cond('between', '0', '9'))).toBe(false);
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
