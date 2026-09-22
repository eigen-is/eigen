// The keyboard routes to the two data-validation affordances the canvas paints.
// Space/Enter over a tick box is covered by the mousedown suite's sibling; this
// file pins the list. The canvas draws the chevron for everyone, keyboard users
// included, but cellFocus — the only thing that positions the Radix anchor — had
// exactly one caller, the mousedown handler, so the affordance was unusable
// without a mouse. handleGlobalKeyDown needs a real DOM, so this file installs
// happy-dom at module scope the way events/mouse-cell.test.ts does.

import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Context } from '../../../state/context';
import { handleGlobalKeyDown } from '../../../state/events/keyboard';
import type { Cell, DataVerificationRule, GlobalCache, SingleRange } from '../../../state/types';
import { contextFactory } from '../factories/context';

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const win = new Window();
g.window = win;
g.document = win.document;

const anchor = win.document.createElement('div');
anchor.id = 'sheet-dataVerification-dropdown-btn';
win.document.body.appendChild(anchor);

const LIST: DataVerificationRule = { type: 'dropdown', type2: '', value1: 'Red,Green,Blue', value2: '' };

function listContext(rule: DataVerificationRule | null = LIST) {
    const ctx = contextFactory() as Context;
    ctx.sheetFocused = true;
    ctx.editingCellPosition = [];
    ctx.selections = [{ row: [1, 1], column: [1, 1], row_focus: 1, column_focus: 1 }];
    if (rule) ctx.sheets[0].dataVerification = { '1_1': rule };
    return ctx;
}

type KeyOptions = { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; cellInput?: HTMLDivElement };

function keyDown(ctx: Context, key: string, { altKey, ctrlKey, shiftKey, cellInput }: KeyOptions = {}) {
    let prevented = false;
    const e = {
        key,
        code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
        keyCode: key === 'ArrowDown' ? 40 : 70,
        altKey: altKey ?? false,
        ctrlKey: ctrlKey ?? false,
        metaKey: false,
        shiftKey: shiftKey ?? false,
        preventDefault() {
            prevented = true;
        },
        stopPropagation() {},
    } as unknown as KeyboardEvent;
    const input = cellInput ?? (win.document.createElement('div') as unknown as HTMLDivElement);
    handleGlobalKeyDown(
        ctx,
        input,
        null,
        e,
        {} as GlobalCache,
        () => {},
        () => {},
    );
    return prevented;
}

describe('handleGlobalKeyDown — Alt+Down over a list cell', () => {
    test('opens the list', () => {
        const ctx = listContext();
        expect(keyDown(ctx, 'ArrowDown', { altKey: true })).toBe(true);
        expect(ctx.dataVerificationDropDownList).toBe(true);
    });

    test('positions the anchor on the cell', () => {
        const ctx = listContext();
        keyDown(ctx, 'ArrowDown', { altKey: true });
        // B2 spans x 74..148, y 20..40 in contextFactory's visibledata*.
        expect(anchor.style.display).toBe('block');
        expect(anchor.style.left).toBe('128px');
    });

    test('a plain Down still moves the selection', () => {
        const ctx = listContext();
        keyDown(ctx, 'ArrowDown');
        expect(ctx.dataVerificationDropDownList).toBeFalsy();
    });

    test('a cell with no list rule falls through to the normal arrow handling', () => {
        const ctx = listContext(null);
        keyDown(ctx, 'ArrowDown', { altKey: true });
        expect(ctx.dataVerificationDropDownList).toBeFalsy();
    });

    test('a read-only viewer gets no list', () => {
        // Same as the mousedown path, which also refuses: cellFocus itself bails.
        const ctx = listContext();
        ctx.allowEdit = false;
        keyDown(ctx, 'ArrowDown', { altKey: true });
        expect(ctx.dataVerificationDropDownList).toBeFalsy();
    });
});

// Ctrl+Shift+F toggles focus into the sheet. The handler is already handed the
// cell input of the workbook that owns the keydown, so a document-wide lookup
// picked the first workbook on the page instead of the one being typed in.
describe('handleGlobalKeyDown — Ctrl+Shift+F focus toggle', () => {
    function addCellInput() {
        const el = win.document.createElement('div');
        win.document.body.appendChild(el);
        return el;
    }

    test('focuses the workbook it was handed, not the first one in the document', () => {
        const first = addCellInput();
        const second = addCellInput();
        const ctx = listContext();
        ctx.sheetFocused = false;

        keyDown(ctx, 'F', { ctrlKey: true, shiftKey: true, cellInput: second as unknown as HTMLDivElement });

        expect(ctx.sheetFocused).toBe(true);
        expect(win.document.activeElement).toBe(second);
        expect(first.getAttribute('tabindex')).toBe(null);
    });

    test('releasing the lock moves no focus, and the lock can be taken back', () => {
        const input = addCellInput();
        const ctx = listContext();
        ctx.sheetFocused = true;

        keyDown(ctx, 'F', { ctrlKey: true, shiftKey: true, cellInput: input as unknown as HTMLDivElement });
        expect(ctx.sheetFocused).toBe(false);
        expect(win.document.activeElement).not.toBe(input);

        keyDown(ctx, 'F', { ctrlKey: true, shiftKey: true, cellInput: input as unknown as HTMLDivElement });
        expect(ctx.sheetFocused).toBe(true);
        expect(win.document.activeElement).toBe(input);
    });
});

// Ctrl+D / Ctrl+R copy the edge cell whole: a formula shifts with the engine's reference
// rules, a value keeps its type and format.
describe('handleGlobalKeyDown — Ctrl+D / Ctrl+R fill', () => {
    const formulas = ['=$B1', '=Z1', '=AA1', '=LOG10(B1)', '=ATAN2(B1,C1)', '=B$1', '=IF(B1="A1",1,2)'];
    const values: Cell[] = [
        { v: 45306, m: '2024-01-15', ct: { fa: 'yyyy-MM-dd', t: 'd' } },
        { v: 0.5, m: '50%', ct: { fa: '0%', t: 'n' } },
        { v: '007', m: '007', ct: { fa: '@', t: 's' }, qp: 1 },
    ];
    const sources: Cell[] = [
        ...formulas.map((f): Cell => ({ f, v: 0, m: '0', ct: { fa: 'General', t: 'n' } })),
        ...values,
    ];
    const FIRST = 30;

    function fillContext(seed: (data: (Cell | null)[][]) => void, selection: SingleRange) {
        const data = Array.from({ length: 12 }, (_, r) =>
            Array.from({ length: 40 }, (_, c): Cell | null => ({
                v: r * 100 + c,
                m: `${r * 100 + c}`,
                ct: { fa: 'General', t: 'n' },
            })),
        );
        seed(data);
        const ctx = contextFactory({
            sheets: [{ name: 'Sheet1', id: 'id_1', order: 0, data }],
            selections: [{ ...selection, row_focus: selection.row[0], column_focus: selection.column[0] }],
        }) as Context;
        ctx.sheetFocused = true;
        ctx.editingCellPosition = [];
        return ctx;
    }

    test('Ctrl+D shifts formulas down and copies values whole', () => {
        const ctx = fillContext((data) => data[0].splice(FIRST, sources.length, ...sources), {
            row: [0, 2],
            column: [FIRST, FIRST + sources.length - 1],
        });
        keyDown(ctx, 'd', { ctrlKey: true });
        const row = ctx.sheets[0].data![2];
        expect(formulas.map((_, i) => row[FIRST + i]?.f)).toEqual([
            '=$B3',
            '=Z3',
            '=AA3',
            '=LOG10(B3)',
            '=ATAN2(B3,C3)',
            '=B$1',
            '=IF(B3="A1",1,2)',
        ]);
        expect(values.map((_, i) => row[FIRST + formulas.length + i])).toEqual(values);
    });

    test('Ctrl+R shifts formulas right and copies values whole', () => {
        const ctx = fillContext(
            (data) => {
                for (const [i, cell] of sources.entries()) data[i][FIRST] = cell;
            },
            { row: [0, sources.length - 1], column: [FIRST, FIRST + 2] },
        );
        keyDown(ctx, 'r', { ctrlKey: true });
        const column = ctx.sheets[0].data!.map((row) => row[FIRST + 2]);
        expect(formulas.map((_, i) => column[i]?.f)).toEqual([
            '=$B1',
            '=AB1',
            '=AC1',
            '=LOG10(D1)',
            '=ATAN2(D1,E1)',
            '=D$1',
            '=IF(D1="A1",1,2)',
        ]);
        expect(values.map((_, i) => column[formulas.length + i])).toEqual(values);
    });
});
