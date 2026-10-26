// The phone's View options menu lists the sorts and the layouts as choices, each current one checked, the sort's
// direction an arrow beside it.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { checkRows, clickRow, menuRows } from '../../menu-rows';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const setMode = mock((_mode: 'list' | 'grid') => {});
const setSort = mock((_key: string, _dir: string) => {});
// On a phone with these preferences only while this file runs: bun keeps a module mock for the files after it.
let mocked = true;
afterAll(() => {
    mocked = false;
});
// The real hooks, held before the mocks replace the modules' exports.
const realMedia = { ...(await import('@workspace/lib/media')) };
mock.module('@workspace/lib/media', () => ({
    ...realMedia,
    useIsMobile: () => mocked || realMedia.useIsMobile(),
}));
const realDrive = { ...(await import('@workspace/lib/drive')) };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useDriveViewPreferences: () =>
        mocked
            ? { mode: 'grid', sortKey: 'modified', sortDir: 'desc', setMode, setSort }
            : realDrive.useDriveViewPreferences(),
}));

const { act, createElement } = await import('react');
const { DriveViewControls } = await import('../../../components/drive/drive-list');

let unmount = async () => {};
afterEach(() => unmount());

async function open() {
    ({ unmount } = await renderInDocument(createElement(DriveViewControls)));
    await act(async () => {
        document
            .querySelector('button[aria-label="View options"]')
            ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
}

test('the sort and the layout in use are checked, the sort with its direction', async () => {
    await open();
    expect(menuRows()).toEqual(['Sort by', 'Name', 'Modified', 'Size', '—', 'List', 'Grid']);
    expect(checkRows()).toEqual([
        ['Name', 'false'],
        ['Modified', 'true'],
        ['Size', 'false'],
        ['List', 'false'],
        ['Grid', 'true'],
    ]);
    const modified = [...document.querySelectorAll('[role="menuitemradio"]')].find(
        (row) => row.textContent === 'Modified',
    );
    expect(modified?.querySelector('.lucide-arrow-down')).not.toBeNull();
});

test('picking the current sort flips its direction, and a layout sets it', async () => {
    await open();
    await clickRow('Modified');
    expect(setSort.mock.calls).toEqual([['modified', 'asc']]);
    await unmount();
    await open();
    await clickRow('List');
    expect(setMode.mock.calls).toEqual([['list']]);
});
