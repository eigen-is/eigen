import { describe, expect, test } from 'bun:test';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { UseListSelectionReturn } from '../../hooks/use-list-selection';
import type { ContextMenuSource } from '../context-menu-event';
import { contextMenuEvent, KEY_SOURCES, POINTER_SOURCES } from '../context-menu-event';
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
// recorded as `kind:id`. The list sits on a background with a menu of its own, as Drive's does, and its row opens its
// own menu on a right-click.
async function mountList(
    startIndex: number,
    selection?: UseListSelectionReturn<Row>,
    scrollToIndex?: (index: number) => void,
) {
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
            onMenu: (item, index) => calls.push(`menu:${item.id}@${index}`),
            shouldNotify: () => false,
            containerRef,
            selection,
            cursorIndex,
            onCursorChange: setCursorIndex,
            scrollToIndex,
        });
        return createElement(
            'div',
            { onContextMenu: () => calls.push('background') },
            createElement(
                'div',
                { ref: containerRef, tabIndex: 0, onKeyDown: handleKeyDown },
                createElement(
                    'div',
                    {
                        'data-row': '',
                        onContextMenu: (e: ReactMouseEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            calls.push('row');
                        },
                    },
                    createElement('button', { type: 'button', 'data-menu': '' }),
                ),
                createPortal(createElement('input', { 'data-dialog-field': '' }), document.body),
            ),
        );
    }
    const { container, unmount } = await renderInDocument(createElement(Harness));
    const find = (root: ParentNode, selector: string) => {
        const element = root.querySelector(selector);
        if (!element) throw new Error(`no ${selector}`);
        return element;
    };
    const keydown = async (target: Element, key: string, init: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
        await act(async () => {
            target.dispatchEvent(event);
        });
        return event;
    };
    // A pointer presses down before its contextmenu, a key doesn't.
    const contextmenu = async (target: Element, source: ContextMenuSource) => {
        const event = contextMenuEvent(source);
        await act(async () => {
            if (event instanceof PointerEvent && !KEY_SOURCES.some((key) => key === source)) {
                const { pointerType, button } = event;
                target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType, button }));
            }
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
        contextmenu,
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

// The menu key is Shift+F10 or the ContextMenu key. On Windows and Linux the browser then also sends a contextmenu
// event to whatever has the focus, which may be the list or, once it opened, the row's menu.
describe('useKeyboardListNavigation menu key', () => {
    test('Shift+F10 and the ContextMenu key open the menu of the row under the cursor', async () => {
        for (const [key, init] of [
            ['F10', { shiftKey: true }],
            ['ContextMenu', {}],
        ] as const) {
            const { calls, list, keydown, unmount } = await mountList(1);
            expect((await keydown(list, key, init)).defaultPrevented).toBe(true);
            expect(calls).toEqual(['menu:b@1']);
            await unmount();
        }
    });

    test('it opens the topmost selected row with no cursor, and nothing with no row, as Enter does', async () => {
        expect(await press('ContextMenu', -1, selectionOf(['b', 'c']))).toEqual(['menu:b@1']);
        const { calls, list, keydown, unmount } = await mountList(-1);
        expect((await keydown(list, 'ContextMenu')).defaultPrevented).toBe(false);
        expect(calls).toEqual([]);
        await unmount();
    });

    // A virtual list draws a row scrolled out of view once its scroll lands: after the key's handler returns, and before
    // the next frame. The test DOM runs a frame's callback at once, so a frame here comes after a timer.
    test('in a virtual list, the menu opens once the row the key scrolled to is drawn', async () => {
        const runAtOnce = globalThis.requestAnimationFrame;
        globalThis.requestAnimationFrame = (callback) => Number(setTimeout(() => callback(performance.now()), 16));
        const drawn = new Set<number>();
        const scrolled: number[] = [];
        const scrollToIndex = (index: number) => {
            scrolled.push(index);
            queueMicrotask(() => drawn.add(index));
        };
        const { calls, list, keydown, unmount } = await mountList(1, undefined, scrollToIndex);
        const opened = new Promise<void>((resolve) => {
            const { push } = calls;
            calls.push = (...entries) => {
                for (const entry of entries) push.call(calls, `${entry} ${drawn.has(1) ? 'drawn' : 'not drawn'}`);
                resolve();
                return calls.length;
            };
        });
        await keydown(list, 'ContextMenu');
        await act(() => opened);
        globalThis.requestAnimationFrame = runAtOnce;
        expect([scrolled, calls]).toEqual([[1], ['menu:b@1 drawn']]);
        await unmount();
    });

    test('F10 without Shift is not the menu key', async () => {
        const { calls, list, keydown, unmount } = await mountList(1);
        expect((await keydown(list, 'F10')).defaultPrevented).toBe(false);
        expect(calls).toEqual([]);
        await unmount();
    });

    // Each browser sends a key's contextmenu its own way, and to whatever has the focus: the list, or a row's ⋮ that a
    // closing menu gave the focus back to.
    test('a key’s contextmenu in the list opens the row’s menu and never reaches the row or the background', async () => {
        for (const source of KEY_SOURCES) {
            const { calls, list, row, menuButton, contextmenu, unmount } = await mountList(1);
            for (const target of [list, row, menuButton]) {
                expect((await contextmenu(target, source)).defaultPrevented).toBe(true);
            }
            expect(calls).toEqual(['menu:b@1', 'menu:b@1', 'menu:b@1']);
            await unmount();
        }
    });

    // The menu is already open on that row, so the second call changes nothing.
    test('the contextmenu that follows the key opens the same row’s menu at most, never another menu', async () => {
        for (const source of KEY_SOURCES) {
            const { calls, list, keydown, contextmenu, unmount } = await mountList(1);
            await keydown(list, 'ContextMenu');
            expect((await contextmenu(list, source)).defaultPrevented).toBe(true);
            expect(calls).toEqual(['menu:b@1', 'menu:b@1']);
            await unmount();
        }
    });

    test('with no row to act on, a key’s contextmenu reaches the background', async () => {
        const { calls, list, contextmenu, unmount } = await mountList(-1);
        expect((await contextmenu(list, 'chrome-key')).defaultPrevented).toBe(false);
        expect(calls).toEqual(['background']);
        await unmount();
    });

    test('a pointer’s contextmenu stays the pointer’s, on a row and below the rows, even right after the key', async () => {
        for (const source of POINTER_SOURCES) {
            const { calls, list, row, keydown, contextmenu, unmount } = await mountList(1);
            await contextmenu(row, source);
            await keydown(list, 'ContextMenu');
            expect((await contextmenu(list, source)).defaultPrevented).toBe(false);
            expect(calls).toEqual(['row', 'menu:b@1', 'background']);
            await unmount();
        }
    });
});
