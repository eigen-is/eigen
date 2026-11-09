// A tab rename takes the names Excel takes: at most 31 characters, none of Excel's forbidden characters, and no
// quote at either end. A refused name puts the old text back in the tab and says why.

import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { SHEET_NAME_FORBIDDEN } = await import('../../../engine/a1-notation');
const { defaultContext } = await import('../../../state/context');
const { editSheetName } = await import('../../../state/modules/sheet');
type Context = import('../../../state/context').Context;

function workbook(): Context {
    const ref = <T>(): { current: T | null } => ({ current: null });
    return {
        ...defaultContext({
            globalCache: {
                undoList: [],
                redoList: [],
                scrollLeft: 0,
                scrollTop: 0,
                scrollListeners: new Set(),
            },
            cellInput: ref(),
            fxInput: ref(),
            canvas: ref(),
            cellArea: ref(),
            workbookContainer: ref(),
            hooks: { current: {} },
        }),
        sheets: [
            { id: 's1', name: 'One', order: 0, config: {} },
            { id: 's2', name: 'Two', order: 1, config: {} },
        ],
        currentSheetId: 's1',
        allowEdit: true,
    };
}

// Renames the first sheet as a typed tab does: the tab holds the new text.
function rename(name: string) {
    const ctx = workbook();
    const tab = document.createElement('span');
    tab.innerText = name;
    let error: string | undefined;
    try {
        editSheetName(ctx, 's1', tab);
    } catch (e) {
        if (e instanceof Error) error = e.message;
    }
    return { name: ctx.sheets[0].name, tab: tab.innerText, error };
}

const FORBIDDEN = ['\\', '/', '?', '*', '[', ']', ':'];

describe('a tab rename', () => {
    test('takes a plain name, and one of 31 characters', () => {
        expect(rename('Q1 2026 "draft"')).toEqual({
            name: 'Q1 2026 "draft"',
            tab: 'Q1 2026 "draft"',
            error: undefined,
        });
        expect(rename('x'.repeat(31)).name).toBe('x'.repeat(31));
    });

    test('takes a ! as Excel does', () => {
        expect(rename('Q1!').name).toBe('Q1!');
    });

    test('takes a fullwidth colon or question mark, as Excel does', () => {
        expect(rename('Plan：A').name).toBe('Plan：A');
        expect(rename('Why？').name).toBe('Why？');
    });

    test('refuses each character Excel refuses, and says which they are', () => {
        for (const character of FORBIDDEN) {
            expect(`a${character}b`.search(SHEET_NAME_FORBIDDEN)).toBe(1);
            const result = rename(`a${character}b`);
            expect(result.name).toBe('One');
            expect(result.tab).toBe('One');
            expect(result.error).toContain(character);
        }
    });

    test('refuses a quote at either end, and a name past 31 characters', () => {
        for (const name of ["'Q1", "Q1'", 'x'.repeat(32)]) {
            const result = rename(name);
            expect(result.name).toBe('One');
            expect(result.error).toBeDefined();
        }
        expect(rename("Q1's").name).toBe("Q1's");
    });

    // A formula's sheet name may read another sheet now, so the formula map is built again on the next edit.
    test('resets the formula map, unless the name stays', () => {
        const ctx = workbook();
        const tab = document.createElement('span');
        tab.innerText = 'One';
        const stays = {};
        ctx.formulaCache.formulaCellInfoMap = stays;
        editSheetName(ctx, 's1', tab);
        expect(ctx.formulaCache.formulaCellInfoMap).toBe(stays);
        tab.innerText = 'Old';
        editSheetName(ctx, 's1', tab);
        expect(ctx.formulaCache.formulaCellInfoMap).not.toBe(stays);
    });

    test('refuses an empty name, and a name another tab has in any case, and says so', () => {
        expect(rename('')).toEqual({ name: 'One', tab: 'One', error: 'Sheet name cannot be empty' });
        const taken = { name: 'One', tab: 'One', error: 'Another sheet already has this name' };
        expect(rename('Two')).toEqual(taken);
        expect(rename('two')).toEqual(taken);
    });
});
