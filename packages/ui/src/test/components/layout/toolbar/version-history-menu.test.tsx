// The Version history submenu lists the versions to restore and, for an owner of the drive, ends with Delete history
// below them, outside the list's scroll area so a long list never hides it. Its pick hands the dialog the size of the
// listed versions, so the dialog says how much it frees without a fetch of its own.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { formatDateTime } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import { DRIVE_MIME_DOC } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { closingDialog, holdClosingDialogs } from '../../../closing-dialog';
import { drivePath } from '../../../drive-path';
import { installHappyDom } from '../../../happy-dom';
import { clickRow, openSubmenu, renderOpenMenu } from '../../../menu-rows';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const HOUR = 3_600_000;
// More versions than the list shows at once.
const versions: Snapshot[] = Array.from({ length: 40 }, (_, i) => ({
    id: `v${i}`,
    name: `v${i}`,
    createdAt: new Date(Date.UTC(2026, 9, 1) - i * HOUR),
    size: 1024 * (i + 1),
}));

let isEffectiveOwner = true;
let listed = versions;
const deleteVersions = mock(async () => {});

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realVersioning = { ...(await import('@workspace/lib/versioning')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
mock.module('@workspace/lib/versioning', () => ({
    ...realVersioning,
    useVersions: () => ({ data: listed }),
    useSaveVersion: () => ({ mutate: () => {}, isPending: false }),
    useDeleteVersions: () => ({ mutateAsync: deleteVersions }),
}));
mock.module('@workspace/lib/drive', () => ({ ...realDrive, useIsEffectiveOwner: () => isEffectiveOwner }));
afterAll(() => {
    mock.module('@workspace/lib/versioning', () => realVersioning);
    mock.module('@workspace/lib/drive', () => realDrive);
});

const { act, createElement } = await import('react');
const { DeleteHistoryDialog, RestoreVersionDialog, StorageGoneVersions, VersionHistoryMenu } = await import(
    '../../../../components/layout/toolbar/version-history-menu'
);

const path = drivePath({ name: 'Plan', mimeType: DRIVE_MIME_DOC });

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    unmount = async () => {};
});

afterEach(() => {
    listed = versions;
});

async function openVersionHistory(onRequestDeleteHistory = (_size: number) => {}): Promise<Element | undefined> {
    ({ unmount } = await renderOpenMenu(
        createElement(VersionHistoryMenu, { path, onRequestRestore: () => {}, onRequestDeleteHistory }),
    ));
    await openSubmenu('Version history');
    return [...document.querySelectorAll('[role="menu"]')].at(-1);
}

const deleteRow = (submenu: Element | undefined) =>
    [...(submenu?.querySelectorAll('[role="menuitem"]') ?? [])].find(
        (row) => row.textContent?.trim() === 'Delete history…',
    );

test('an owner of the drive gets Delete history as the last row, red, below the scrolling list', async () => {
    isEffectiveOwner = true;
    const onRequestDeleteHistory = mock((_size: number) => {});
    const submenu = await openVersionHistory(onRequestDeleteHistory);

    const row = deleteRow(submenu);
    expect(row?.getAttribute('data-variant')).toBe('destructive');
    expect(submenu?.lastElementChild).toBe(row ?? null);
    expect(row?.previousElementSibling?.getAttribute('role')).toBe('separator');
    const list = submenu?.querySelector('.overflow-y-auto');
    expect(list?.querySelectorAll('[role="menuitem"]').length).toBe(versions.length);
    expect(row && list?.contains(row)).toBe(false);

    await clickRow('Delete history…');
    expect(onRequestDeleteHistory.mock.calls).toEqual([[versions.reduce((sum, version) => sum + version.size, 0)]]);
});

test('an editor who does not own the drive gets no Delete history', async () => {
    isEffectiveOwner = false;
    const submenu = await openVersionHistory();
    expect(submenu?.querySelectorAll('[role="menuitem"]').length).toBe(versions.length);
    expect(deleteRow(submenu)).toBeUndefined();
});

test('the dialog names the size the menu passed and deletes on its button', async () => {
    deleteVersions.mockClear();
    const size = 5 * 1024 * 1024;
    ({ unmount } = await renderInDocument(
        createElement(DeleteHistoryDialog, { path, size, open: true, onOpenChange: () => {} }),
    ));
    const dialog = document.querySelector('[role="dialog"]');

    expect(dialog?.querySelector('h2')?.textContent).toBe('Delete version history?');
    expect(dialog?.querySelector('p')?.textContent).toBe(
        `Frees ${formatFileSize(size)}. Earlier versions of this document and its comments can't be restored after ` +
            'this. Images and comments you deleted are removed now, except those added or replied to in the last 3 ' +
            'days.',
    );
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === 'Delete history',
    );
    await act(async () => confirm?.click());
    expect(deleteVersions).toHaveBeenCalledTimes(1);
});

test('Delete history is grayed out while there are no versions, and live with one', async () => {
    isEffectiveOwner = true;
    listed = [];
    const empty = await openVersionHistory();
    expect(deleteRow(empty)?.hasAttribute('data-disabled')).toBe(true);
    await unmount();

    listed = versions.slice(0, 1);
    const submenu = await openVersionHistory();
    expect(deleteRow(submenu)?.hasAttribute('data-disabled')).toBe(false);
});

test('the restore dialog on the gone screen keeps naming the version while it closes', async () => {
    const release = holdClosingDialogs();
    try {
        const [version] = versions;
        ({ unmount } = await renderInDocument(createElement(StorageGoneVersions, { path })));
        const click = (button: Element | null | undefined) =>
            act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await click(document.querySelector('button'));
        await click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Cancel'));
        expect(closingDialog()?.querySelector('p')?.textContent).toContain(
            `the ${formatDateTime(version.createdAt)} version`,
        );
    } finally {
        release();
    }
});

test('the restore dialog says comments go back with their text and replies stay', async () => {
    ({ unmount } = await renderInDocument(
        createElement(RestoreVersionDialog, { path, snapshot: versions[0], open: true, onOpenChange: () => {} }),
    ));
    const text = document.querySelector('[role="dialog"] p')?.textContent;
    expect(text).toContain("Comments go back with the text they're on. Their replies stay as they are now.");
    expect(text).not.toContain('attachments');
});
