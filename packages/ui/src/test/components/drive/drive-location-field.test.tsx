// The Location bar of a folder picker, such as Save to Drive's, opens and closes the folder browser from a button the
// keyboard reaches: Enter, Space and a click. Open, its crumbs pick a folder and New folder works, without closing it.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import type { DriveLocationValue } from '../../../components/drive/drive-browser';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { pressKey } from '../../press-key';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const root = drivePath({ id: 'root', name: 'Drive', mimeType: DRIVE_MIME_FOLDER, type: 'folder' });
const docs = drivePath({ id: 'docs', name: 'Docs', mimeType: DRIVE_MIME_FOLDER, type: 'folder', parentId: 'root' });

const session = { user: { id: 'owner-1' } };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realBrowser = { ...(await import('../../../components/drive/drive-browser')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useRootFolder: () => ({ data: root }),
    useBreadcrumb: () => ({ data: [root, docs] }),
}));
let createFolderOpen = false;
mock.module('../../../components/drive/drive-browser', () => ({
    ...realBrowser,
    DriveBrowser: (props: { newFolder: { open: boolean } }) => {
        createFolderOpen = props.newFolder.open;
        return null;
    },
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('../../../components/drive/drive-browser', () => realBrowser);
});

const { act, createElement, useState } = await import('react');
const { DriveLocationField } = await import('../../../components/drive/drive-location-field');

let unmount = async () => {};
afterEach(() => unmount());

const onChange = mock((_value: DriveLocationValue) => {});
function Host() {
    const [expanded, setExpanded] = useState(false);
    return createElement(DriveLocationField, {
        value: { ownerId: 'owner-1', mountId: 'default', folderId: 'docs' },
        onChange,
        expanded,
        onExpandedChange: setExpanded,
    });
}

const find = (selector: string) => {
    const found = document.querySelector(selector);
    if (!found) throw new Error(`nothing matches ${selector}`);
    return found;
};
const toggle = () => find('button[aria-expanded]');
const expanded = () => toggle().getAttribute('aria-expanded');
const click = (target: Element) =>
    act(async () => {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

test('the bar is a button named for what it does, which Enter, Space and a click toggle', async () => {
    ({ unmount } = await renderInDocument(createElement(Host)));
    expect(toggle().getAttribute('aria-label')).toBe('Change location');
    // Its focus ring draws inside the bar, so a picker that scrolls doesn't clip it.
    expect(toggle().classList.contains('focus-visible:after:ring-inset')).toBe(true);
    expect(expanded()).toBe('false');
    await act(async () => pressKey(toggle(), 'Enter'));
    expect(expanded()).toBe('true');
    await act(async () => pressKey(toggle(), ' '));
    expect(expanded()).toBe('false');
    await click(toggle());
    expect(expanded()).toBe('true');
});

test('open, a crumb picks its folder and New folder opens, and the browser stays open', async () => {
    onChange.mockClear();
    ({ unmount } = await renderInDocument(createElement(Host)));
    await click(toggle());
    const crumb = [...document.querySelectorAll('[data-slot="breadcrumb-link"]')].find(
        (c) => c.textContent === 'Drive',
    );
    if (!crumb) throw new Error('no crumb for the root');
    await click(crumb);
    expect(onChange.mock.calls).toEqual([[{ ownerId: root.ownerId, mountId: 'default', folderId: root.id }]]);
    await click(find('button[aria-label="New folder"]'));
    expect(createFolderOpen).toBe(true);
    expect(expanded()).toBe('true');
    // Neither control sits inside the toggle, which would make it a button in a button.
    expect(toggle().contains(crumb) || toggle().contains(find('button[aria-label="New folder"]'))).toBe(false);
});
