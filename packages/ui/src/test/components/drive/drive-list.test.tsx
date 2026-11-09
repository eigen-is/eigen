// The phone's View options menu lists the sorts and the layouts as choices, each current one checked, the sort's
// direction an arrow beside it. A listing with a sort of its own gets the pick, and the preference stays as it was.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { ComponentProps } from 'react';
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

async function open(props: ComponentProps<typeof DriveViewControls> = {}) {
    ({ unmount } = await renderInDocument(createElement(DriveViewControls, props)));
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

test('a sort of its own is checked, and a pick goes to its caller instead of the preference', async () => {
    setSort.mockClear();
    const onChange = mock((_sort: { key: string; dir: string }) => {});
    await open({ sort: { value: { key: 'name', dir: 'asc' }, onChange } });
    expect(checkRows().slice(0, 3)).toEqual([
        ['Name', 'true'],
        ['Modified', 'false'],
        ['Size', 'false'],
    ]);
    await clickRow('Name');
    expect(onChange.mock.calls).toEqual([[{ key: 'name', dir: 'desc' }]]);
    expect(setSort).not.toHaveBeenCalled();
});
