import { describe, expect, test } from 'bun:test';
import type { UseListSelectionReturn } from '../../hooks/use-list-selection';
import { installHappyDom } from '../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useListSelection } = await import('../../hooks/use-list-selection');

type Row = { id: string };
const ROWS: Row[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const getId = (row: Row) => row.id;

// A list whose page opens the row `openId` names, as a click on a contact or a user does.
function mount(openId?: string) {
    let latest: UseListSelectionReturn<Row> | null = null;
    function Harness({ openId }: { openId?: string }) {
        latest = useListSelection({ items: ROWS, getId, openId });
        return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Harness, { openId })));
    const selected = () => [...(latest?.selectedIds ?? [])];
    return {
        selection: () => {
            if (latest === null) throw new Error('hook has not rendered');
            return latest;
        },
        selected,
        open: (id?: string) => act(() => root.render(createElement(Harness, { openId: id }))),
        unmount: () => act(() => root.unmount()),
    };
}

describe('useListSelection with an open row', () => {
    test('closing the detail drops the selection its click made', () => {
        const h = mount();
        act(() => h.selection().select('a'));
        h.open('a');
        h.open(undefined);
        expect(h.selected()).toEqual([]);
        h.unmount();
    });

    test('a selection of several rows stays when the detail closes', () => {
        const h = mount('a');
        act(() => h.selection().setSelection(['a', 'c']));
        h.open(undefined);
        expect(h.selected()).toEqual(['a', 'c']);
        h.unmount();
    });

    test('opening another row is no close', () => {
        const h = mount('a');
        act(() => h.selection().select('b'));
        h.open('b');
        expect(h.selected()).toEqual(['b']);
        h.unmount();
    });
});
