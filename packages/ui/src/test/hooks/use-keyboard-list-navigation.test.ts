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
// known row. -1 is the no-selection state every list starts in.
function press(key: string, cursorIndex: number, selection?: UseListSelectionReturn<Row>): string[] {
    const deleted: string[] = [];
    const seen: { handleKeyDown: ((e: KeyboardEvent<HTMLElement>) => void) | null } = { handleKeyDown: null };

    function Harness() {
        seen.handleKeyDown = useKeyboardListNavigation<Row>({
            items: ROWS,
            getId: (item) => item.id,
            onSelect: () => {},
            onDelete: (item) => deleted.push(item.id),
            containerRef: createRef<HTMLElement>(),
            selection,
            cursorIndex,
            onCursorChange: () => {},
        }).handleKeyDown;
        return null;
    }

    renderToStaticMarkup(createElement(Harness));
    seen.handleKeyDown?.({ key, preventDefault: () => {} } as unknown as KeyboardEvent<HTMLElement>);
    return deleted;
}

describe('useKeyboardListNavigation delete keys', () => {
    test('Delete and Backspace both delete the row under the cursor', () => {
        expect(press('Delete', 1)).toEqual(['b']);
        expect(press('Backspace', 1)).toEqual(['b']);
    });

    test('neither fires with no selection', () => {
        expect(press('Delete', -1)).toEqual([]);
        expect(press('Backspace', -1)).toEqual([]);
    });

    // ⌘A on a list nobody clicked yet selects every row while the cursor stays at -1.
    test('a cursorless selection deletes from the first selected row', () => {
        expect(press('Delete', -1, selectionOf(['a', 'b', 'c']))).toEqual(['a']);
        expect(press('Backspace', -1, selectionOf(['b', 'c']))).toEqual(['b']);
    });

    test('the cursor still wins over the selection', () => {
        expect(press('Delete', 2, selectionOf(['a', 'b', 'c']))).toEqual(['c']);
    });
});
