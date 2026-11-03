// A Drive table row draws its states the way Mail's list does. The open row has the stripe and the wash, a selected
// row has the wash, and the keyboard cursor on any other row has the stripe only. So once a right-click moves the
// selection away from the cursor, only one row still looks selected.
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => Response.json([]), { preconnect: fetch.preconnect }),
);
// happy-dom lays nothing out, and the virtualizer draws no row in a scroller 0 px tall. Every happy-dom window shares
// one HTMLElement class, which owns clientHeight itself, so afterAll puts its getter back rather than deleting the stub.
// The prototype is held here, as the window's globals are gone by the time afterAll runs.
const elementPrototype = HTMLElement.prototype;
const clientHeight = Object.getOwnPropertyDescriptor(elementPrototype, 'clientHeight');
Object.defineProperty(elementPrototype, 'clientHeight', { configurable: true, get: () => 600 });
afterAll(() => {
    fetchSpy.mockRestore();
    if (clientHeight) Object.defineProperty(elementPrototype, 'clientHeight', clientHeight);
});

const { act, createElement } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { DriveTable } = await import('../../../components/drive/drive-table');

let unmount = async () => {};
afterEach(() => unmount());

const ITEMS = ['a', 'b', 'c'].map((id) =>
    drivePath({ id, name: `${id.toUpperCase()}.txt`, type: 'file', mimeType: 'text/plain' }),
);

async function renderTable(activeItemId?: string) {
    ({ unmount } = await renderInDocument(
        createElement(AuthProvider, null, createElement(DriveTable, { items: ITEMS, activeItemId })),
    ));
    const list = document.querySelector('[role="grid"]');
    if (!(list instanceof HTMLElement)) throw new Error('no table');
    return list;
}

// Each row's state classes, in row order.
function rowStates(): string[][] {
    return [...document.querySelectorAll('[role="row"].eigen-list-item')].map((row) =>
        ['active', 'cursor', 'selected'].filter((state) => row.classList.contains(`eigen-list-item-${state}`)),
    );
}

async function rightClick(index: number) {
    const row = document.querySelectorAll('[role="row"].eigen-list-item')[index];
    if (!row) throw new Error(`no row ${index}`);
    await act(async () => {
        row.dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    });
}

test('the cursor row keeps only the stripe once a right-click selects another row', async () => {
    const list = await renderTable();
    await act(async () => {
        list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(rowStates()).toEqual([['cursor', 'selected'], [], []]);
    await rightClick(2);
    expect(rowStates()).toEqual([['cursor'], [], ['selected']]);
});

test('the open row has the full look, as after a plain click, and keeps it while another row is selected', async () => {
    await renderTable('b');
    expect(rowStates()).toEqual([[], ['active', 'selected'], []]);
    await rightClick(0);
    expect(rowStates()).toEqual([['selected'], ['active'], []]);
});
