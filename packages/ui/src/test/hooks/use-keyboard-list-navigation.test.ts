import { describe, expect, test } from 'bun:test';
import { createElement, createRef, type KeyboardEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useKeyboardListNavigation } from '../../hooks/use-keyboard-list-navigation';

type Row = { id: string };
const ROWS: Row[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

// A static render runs no effects, so the cursor is lifted (mail's mode) to put the list on a
// known row. -1 is the no-selection state every list starts in.
function press(key: string, cursorIndex: number): string[] {
    const deleted: string[] = [];
    const seen: { handleKeyDown: ((e: KeyboardEvent<HTMLElement>) => void) | null } = { handleKeyDown: null };

    function Harness() {
        seen.handleKeyDown = useKeyboardListNavigation<Row>({
            items: ROWS,
            getId: (item) => item.id,
            onSelect: () => {},
            onDelete: (item) => deleted.push(item.id),
            containerRef: createRef<HTMLElement>(),
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
});
