// FUNCTION_LIST's `t` is the Insert → Function category id, and the dialog
// filters on it with `===`. That makes the field's *type* load-bearing: one
// entry (UNIQUE) carried `t: '14'` as a string from upstream, so it never
// matched its own category and could only be found by search. Pinned here
// against the dialog's own category list, so a new orphan category or a
// re-introduced string shows up as a failing test rather than an empty tab.

import { describe, expect, test } from 'bun:test';
import { FUNCTION_CATEGORIES } from '../../../components/InsertFunctionDialog';
import { FUNCTION_LIST } from '../../../state/modules/function-list';

// Categories the dialog has no tab for, so their functions are search-only.
// Tracked in docs/SHEETS-TODO.md § Code debt, not fixed here.
const CATEGORIES_WITHOUT_A_TAB = [15, 17];

describe('FUNCTION_LIST categories', () => {
    test('every entry carries a numeric category id', () => {
        const wrong = FUNCTION_LIST.filter((fn) => typeof fn.t !== 'number' || !Number.isInteger(fn.t));
        expect(wrong.map((fn) => fn.n)).toEqual([]);
    });

    test('every category id is a dialog tab or a known tab-less one', () => {
        const known = new Set([...FUNCTION_CATEGORIES.map((c) => c.t), ...CATEGORIES_WITHOUT_A_TAB]);
        const orphans = [...new Set(FUNCTION_LIST.filter((fn) => !known.has(fn.t)).map((fn) => fn.t))];
        expect(orphans).toEqual([]);
    });

    test('UNIQUE is reachable under the Array category, not only by search', () => {
        const array = FUNCTION_CATEGORIES.find((c) => c.n === 'Array');
        expect(array).toBeDefined();
        // The dialog's own predicate (InsertFunctionDialog: `v.t === selectedType`).
        const names = FUNCTION_LIST.filter((fn) => fn.t === array!.t).map((fn) => fn.n);
        expect(names).toContain('UNIQUE');
    });
});
