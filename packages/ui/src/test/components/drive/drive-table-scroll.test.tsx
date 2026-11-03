// The table's column header is sticky at the top of the scroller, so a row the virtualizer scrolls into view from
// below must stop under the header, not behind it. happy-dom lays nothing out: the list's offset in the scroller is
// stubbed to the header's height, and the test reads the options the table gives the virtualizer.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

const window = installHappyDom();

// The options of the table's last render, recorded on the way to the real virtualizer while this file runs: bun keeps
// a module mock for the files after it.
let mocked = true;
afterAll(() => {
    mocked = false;
});
let seen: { scrollMargin?: number; scrollPaddingStart?: number } = {};
const realVirtual = { ...(await import('@tanstack/react-virtual')) };
mock.module('@tanstack/react-virtual', () => ({
    ...realVirtual,
    useVirtualizer: (options: Parameters<typeof realVirtual.useVirtualizer>[0]) => {
        if (mocked) seen = { scrollMargin: options.scrollMargin, scrollPaddingStart: options.scrollPaddingStart };
        return realVirtual.useVirtualizer(options);
    },
}));
// The shared view preference reads the signed-in user's settings, which this test has none of.
const realDrive = { ...(await import('@workspace/lib/drive')) };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useDriveViewPreferences: () =>
        mocked
            ? { mode: 'list', sortKey: 'name', sortDir: 'asc', setMode: () => {}, setSort: () => {} }
            : realDrive.useDriveViewPreferences(),
}));

const { act, createElement, useState } = await import('react');
const { DriveTable } = await import('../../../components/drive/drive-table');

const HEADER_HEIGHT = 41;
// The list follows the sticky header in the scroller, so its offset there is the header's height.
const offsetTop = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'offsetTop');
Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
        return this.previousElementSibling?.classList.contains('sticky') ? HEADER_HEIGHT : 0;
    },
});
afterAll(() => {
    if (offsetTop) Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', offsetTop);
});

let unmount = async () => {};
afterEach(() => unmount());

const FILES: DrivePath[] = Array.from({ length: 50 }, (_, i) =>
    drivePath({ id: `f${i}`, name: `f${i}.txt`, type: 'file', mimeType: 'text/plain' }),
);

// The table reads the list's offset as it renders, so a second render sees the list the first one drew.
async function renderTable(hideHeader: boolean) {
    const table = { redraw: () => {} };
    function Table() {
        const [, setVersion] = useState(0);
        table.redraw = () => setVersion((v) => v + 1);
        return createElement(DriveTable, { items: FILES, hideHeader });
    }
    ({ unmount } = await renderInDocument(createElement(Table)));
    await act(async () => table.redraw());
    return seen;
}

test('a row scrolled into view stops below the sticky header', async () => {
    expect(await renderTable(false)).toEqual({ scrollMargin: HEADER_HEIGHT, scrollPaddingStart: HEADER_HEIGHT });
});

test('without a header a row scrolls to the top of the view', async () => {
    expect(await renderTable(true)).toEqual({ scrollMargin: 0, scrollPaddingStart: 0 });
});
