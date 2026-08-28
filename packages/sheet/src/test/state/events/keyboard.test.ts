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
import type { DataVerificationRule, GlobalCache } from '../../../state/types';
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

function keyDown(ctx: Context, key: string, altKey: boolean) {
    let prevented = false;
    const e = {
        key,
        keyCode: key === 'ArrowDown' ? 40 : 0,
        altKey,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        preventDefault() {
            prevented = true;
        },
        stopPropagation() {},
    } as unknown as KeyboardEvent;
    const input = win.document.createElement('div') as unknown as HTMLDivElement;
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
        expect(keyDown(ctx, 'ArrowDown', true)).toBe(true);
        expect(ctx.dataVerificationDropDownList).toBe(true);
    });

    test('positions the anchor on the cell', () => {
        const ctx = listContext();
        keyDown(ctx, 'ArrowDown', true);
        // B2 spans x 74..148, y 20..40 in contextFactory's visibledata*.
        expect(anchor.style.display).toBe('block');
        expect(anchor.style.left).toBe('128px');
    });

    test('a plain Down still moves the selection', () => {
        const ctx = listContext();
        keyDown(ctx, 'ArrowDown', false);
        expect(ctx.dataVerificationDropDownList).toBeFalsy();
    });

    test('a cell with no list rule falls through to the normal arrow handling', () => {
        const ctx = listContext(null);
        keyDown(ctx, 'ArrowDown', true);
        expect(ctx.dataVerificationDropDownList).toBeFalsy();
    });

    test('a read-only viewer gets no list', () => {
        // Same as the mousedown path, which also refuses: cellFocus itself bails.
        const ctx = listContext();
        ctx.allowEdit = false;
        keyDown(ctx, 'ArrowDown', true);
        expect(ctx.dataVerificationDropDownList).toBeFalsy();
    });
});

// Ctrl+Shift+F toggles focus into the sheet. The handler is already handed the
// cell input of the workbook that owns the keydown, so a document-wide lookup
// picked the first workbook on the page instead of the one being typed in.
describe('handleGlobalKeyDown — Ctrl+Shift+F focus toggle', () => {
    function addCellInput() {
        const el = win.document.createElement('div');
        el.className = 'sheet-cell-input';
        win.document.body.appendChild(el);
        return el;
    }

    function ctrlShiftF(ctx: Context, cellInput: HTMLDivElement) {
        const e = {
            key: 'F',
            keyCode: 70,
            altKey: false,
            ctrlKey: true,
            metaKey: false,
            shiftKey: true,
            preventDefault() {},
            stopPropagation() {},
        } as unknown as KeyboardEvent;
        handleGlobalKeyDown(
            ctx,
            cellInput,
            null,
            e,
            {} as GlobalCache,
            () => {},
            () => {},
        );
    }

    test('focuses the workbook it was handed, not the first one in the document', () => {
        const first = addCellInput();
        const second = addCellInput();
        const ctx = listContext();
        ctx.sheetFocused = false;

        ctrlShiftF(ctx, second as unknown as HTMLDivElement);

        expect(ctx.sheetFocused).toBe(true);
        expect(win.document.activeElement).toBe(second);
        expect(first.getAttribute('tabindex')).toBe(null);
    });
});
