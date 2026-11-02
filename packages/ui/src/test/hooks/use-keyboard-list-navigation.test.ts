import { describe, expect, test } from 'bun:test';
import type { UseListSelectionReturn } from '../../hooks/use-list-selection';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement, useRef, useState } = await import('react');
const { createPortal } = await import('react-dom');
const { useKeyboardListNavigation } = await import('../../hooks/use-keyboard-list-navigation');

type Row = { id: string };
const ROWS: Row[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

// The selection is a frozen stand-in for what useListSelection holds after ⌘A.
function selectionOf(ids: string[]): UseListSelectionReturn<Row> {
    const selectedIds = new Set(ids);
    return {
        selectedIds,
        isSelected: (id) => selectedIds.has(id),
        selectedItems: ROWS.filter((row) => selectedIds.has(row.id)),
        selectedCount: selectedIds.size,
        hasSelection: selectedIds.size > 0,
        select: () => {},
        toggle: () => {},
        selectRange: () => {},
        selectAll: () => {},
        setSelection: () => {},
        clearSelection: () => {},
        handleItemClick: () => {},
    };
}

// A list with one row that holds a ⋮ button, and a field portaled out of it to the body, the way a dialog opened from a row's menu sits in
// the list's React tree but not in its DOM. The cursor is lifted (mail's mode) and starts on a known row; -1 is
// the no-selection state every list starts in. A move opens nothing, as in Drive with no row open. Each callback is
// recorded as `kind:id`.
async function mountList(startIndex: number, selection?: UseListSelectionReturn<Row>) {
    const calls: string[] = [];
    function Harness() {
        const containerRef = useRef<HTMLDivElement>(null);
        const [cursorIndex, setCursorIndex] = useState(startIndex);
        const { handleKeyDown } = useKeyboardListNavigation<Row>({
            items: ROWS,
            getId: (item) => item.id,
            onSelect: (id) => calls.push(`open:${id}`),
            onQuickLook: (id) => calls.push(`look:${id}`),
            onDelete: (item) => calls.push(`delete:${item.id}`),
            shouldNotify: () => false,
            containerRef,
            selection,
            cursorIndex,
            onCursorChange: setCursorIndex,
        });
        return createElement(
            'div',
            { ref: containerRef, tabIndex: 0, onKeyDown: handleKeyDown },
            createElement('div', { 'data-row': '' }, createElement('button', { type: 'button', 'data-menu': '' })),
            createPortal(createElement('input', { 'data-dialog-field': '' }), document.body),
        );
    }
    const { container, unmount } = await renderInDocument(createElement(Harness));
    const find = (root: ParentNode, selector: string) => {
        const element = root.querySelector(selector);
        if (!element) throw new Error(`no ${selector}`);
        return element;
    };
    const keydown = async (target: Element, key: string) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        await act(async () => {
            target.dispatchEvent(event);
        });
        return event;
    };
    return {
        calls,
        list: find(container, '[tabindex]'),
        row: find(container, '[data-row]'),
        menuButton: find(container, '[data-menu]'),
        field: find(document.body, '[data-dialog-field]'),
        keydown,
        unmount,
    };
}

async function press(key: string, cursorIndex: number, selection?: UseListSelectionReturn<Row>): Promise<string[]> {
    const { calls, row, keydown, unmount } = await mountList(cursorIndex, selection);
    await keydown(row, key);
    await unmount();
    return calls;
}

describe('useKeyboardListNavigation delete keys', () => {
    test('Delete and Backspace both delete the row under the cursor', async () => {
        expect(await press('Delete', 1)).toEqual(['delete:b']);
        expect(await press('Backspace', 1)).toEqual(['delete:b']);
    });

    test('neither fires with no selection', async () => {
        expect(await press('Delete', -1)).toEqual([]);
        expect(await press('Backspace', -1)).toEqual([]);
    });

    // ⌘A on a list nobody clicked yet selects every row while the cursor stays at -1.
    test('a cursorless selection deletes from the first selected row', async () => {
        expect(await press('Delete', -1, selectionOf(['a', 'b', 'c']))).toEqual(['delete:a']);
        expect(await press('Backspace', -1, selectionOf(['b', 'c']))).toEqual(['delete:b']);
    });

    test('the cursor still wins over the selection', async () => {
        expect(await press('Delete', 2, selectionOf(['a', 'b', 'c']))).toEqual(['delete:c']);
    });
});

describe('useKeyboardListNavigation Space and Enter', () => {
    test('Space quick-looks and Enter opens the row under the cursor', async () => {
        expect(await press(' ', 1)).toEqual(['look:b']);
        expect(await press('Enter', 1)).toEqual(['open:b']);
    });

    test('neither fires with no selection', async () => {
        expect(await press(' ', -1)).toEqual([]);
        expect(await press('Enter', -1)).toEqual([]);
    });

    test('a cursorless selection acts on the topmost selected row, as Delete does', async () => {
        expect(await press(' ', -1, selectionOf(['b', 'c']))).toEqual(['look:b']);
        expect(await press('Enter', -1, selectionOf(['a', 'b', 'c']))).toEqual(['open:a']);
    });

    test('the cursor still wins over the selection', async () => {
        expect(await press('Enter', 2, selectionOf(['a', 'b', 'c']))).toEqual(['open:c']);
    });

    test('on the focused list itself, Enter opens and Space quick-looks', async () => {
        const { calls, list, keydown, unmount } = await mountList(1);
        expect((await keydown(list, 'Enter')).defaultPrevented).toBe(true);
        expect((await keydown(list, ' ')).defaultPrevented).toBe(true);
        expect(calls).toEqual(['open:b', 'look:b']);
        await unmount();
    });

    test('on a button inside a row, Enter and Space press the button and leave the row alone', async () => {
        const { calls, menuButton, keydown, unmount } = await mountList(1);
        for (const key of ['Enter', ' ']) {
            expect((await keydown(menuButton, key)).defaultPrevented).toBe(false);
        }
        expect(calls).toEqual([]);
        await unmount();
    });

    // A row's menu hands the focus back to its ⋮ button when it closes.
    test('a key that moves the cursor off a row’s button hands the focus back, so Enter opens the new row', async () => {
        for (const key of ['ArrowDown', 'End']) {
            const { calls, list, menuButton, keydown, unmount } = await mountList(0);
            if (!(menuButton instanceof HTMLElement)) throw new Error('no menu button');
            menuButton.focus();
            await keydown(menuButton, key);
            expect(document.activeElement).toBe(list);
            await keydown(list, 'Enter');
            expect(calls).toEqual([key === 'End' ? 'open:c' : 'open:b']);
            await unmount();
        }
    });
});

describe('useKeyboardListNavigation and a dialog opened from the list', () => {
    test('a key pressed in a portaled field is the field’s, and the list neither acts nor claims it', async () => {
        const { calls, field, keydown, unmount } = await mountList(1, selectionOf(['b']));
        for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Backspace', 'Escape', 'Home']) {
            const event = await keydown(field, key);
            expect(event.defaultPrevented).toBe(false);
        }
        expect(calls).toEqual([]);
        await unmount();
    });
});
