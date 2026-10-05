import { describe, expect, test } from 'bun:test';
import type { DragEvent } from 'react';
import type { UseListSelectionReturn } from '../../hooks/use-list-selection';
import { installHappyDom } from '../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useListDrag } = await import('../../hooks/use-list-drag');
const { useListSelection } = await import('../../hooks/use-list-selection');

type Row = { id: string };
const ROWS: Row[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const getId = (row: Row) => row.id;

function mount() {
    let latest: { selection: UseListSelectionReturn<Row>; drag: ReturnType<typeof useListDrag<Row>> } | null = null;
    function Harness() {
        const selection = useListSelection({ items: ROWS, getId });
        latest = { selection, drag: useListDrag({ selection, getId, dragType: 'row' }) };
        return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Harness)));
    const current = () => {
        if (latest === null) throw new Error('hook has not rendered');
        return latest;
    };
    return {
        current,
        // The ids the drag payload carries, as a drop target reads them.
        dragStart(row: Row): string[] {
            let payload = '';
            const event = {
                dataTransfer: {
                    setData: (_type: string, data: string) => {
                        payload = data;
                    },
                    setDragImage: () => {},
                    effectAllowed: 'none',
                },
            } as unknown as DragEvent;
            act(() => current().drag.getDragProps(row).onDragStart(event));
            return JSON.parse(payload).ids;
        },
        unmount: () => act(() => root.unmount()),
    };
}

describe('useListDrag', () => {
    test('dragging an unselected row carries that row, not the old selection', () => {
        const h = mount();
        act(() => h.current().selection.select('a'));
        expect(h.dragStart({ id: 'b' })).toEqual(['b']);
        expect([...h.current().selection.selectedIds]).toEqual(['b']);
        expect(h.current().drag.draggedItems).toEqual([{ id: 'b' }]);
        h.unmount();
    });

    test('dragging a selected row carries the whole selection', () => {
        const h = mount();
        act(() => h.current().selection.setSelection(['a', 'c']));
        expect(h.dragStart({ id: 'c' })).toEqual(['a', 'c']);
        h.unmount();
    });
});
