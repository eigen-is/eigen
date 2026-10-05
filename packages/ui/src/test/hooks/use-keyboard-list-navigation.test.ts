import { describe, expect, test } from 'bun:test';
import { createElement, createRef, type KeyboardEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useKeyboardListNavigation } from '../../hooks/use-keyboard-list-navigation';
import type { UseListSelectionReturn } from '../../hooks/use-list-selection';

type Row = { id: string };
const ROWS: Row[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

// No state updates run in a static render, so the selection is a frozen stand-in for what
// useListSelection holds after ⌘A.
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
        anchorId: null,
    };
}

// A static render runs no effects, so the cursor is lifted (mail's mode) to put the list on a
// known row. -1 is the no-selection state every list starts in. Returns each callback as `kind:id`.
function press(key: string, cursorIndex: number, selection?: UseListSelectionReturn<Row>): string[] {
    const calls: string[] = [];
    const seen: { handleKeyDown: ((e: KeyboardEvent<HTMLElement>) => void) | null } = { handleKeyDown: null };

    function Harness() {
        seen.handleKeyDown = useKeyboardListNavigation<Row>({
            items: ROWS,
            getId: (item) => item.id,
            onSelect: (id) => calls.push(`open:${id}`),
            onQuickLook: (id) => calls.push(`look:${id}`),
            onDelete: (item) => calls.push(`delete:${item.id}`),
            containerRef: createRef<HTMLElement>(),
            selection,
            cursorIndex,
            onCursorChange: () => {},
        }).handleKeyDown;
        return null;
    }

    renderToStaticMarkup(createElement(Harness));
    seen.handleKeyDown?.({
        key,
        preventDefault: () => {},
        stopPropagation: () => {},
    } as unknown as KeyboardEvent<HTMLElement>);
    return calls;
}

describe('useKeyboardListNavigation delete keys', () => {
    test('Delete and Backspace both delete the row under the cursor', () => {
        expect(press('Delete', 1)).toEqual(['delete:b']);
        expect(press('Backspace', 1)).toEqual(['delete:b']);
    });

    test('neither fires with no selection', () => {
        expect(press('Delete', -1)).toEqual([]);
        expect(press('Backspace', -1)).toEqual([]);
    });

    // ⌘A on a list nobody clicked yet selects every row while the cursor stays at -1.
    test('a cursorless selection deletes from the first selected row', () => {
        expect(press('Delete', -1, selectionOf(['a', 'b', 'c']))).toEqual(['delete:a']);
        expect(press('Backspace', -1, selectionOf(['b', 'c']))).toEqual(['delete:b']);
    });

    test('the cursor still wins over the selection', () => {
        expect(press('Delete', 2, selectionOf(['a', 'b', 'c']))).toEqual(['delete:c']);
    });
});

describe('useKeyboardListNavigation Space and Enter', () => {
    test('Space quick-looks and Enter opens the row under the cursor', () => {
        expect(press(' ', 1)).toEqual(['look:b']);
        expect(press('Enter', 1)).toEqual(['open:b']);
    });

    test('neither fires with no selection', () => {
        expect(press(' ', -1)).toEqual([]);
        expect(press('Enter', -1)).toEqual([]);
    });

    test('a cursorless selection acts on the topmost selected row, as Delete does', () => {
        expect(press(' ', -1, selectionOf(['b', 'c']))).toEqual(['look:b']);
        expect(press('Enter', -1, selectionOf(['a', 'b', 'c']))).toEqual(['open:a']);
    });

    test('the cursor still wins over the selection', () => {
        expect(press('Enter', 2, selectionOf(['a', 'b', 'c']))).toEqual(['open:c']);
    });
});
