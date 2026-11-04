// The Version history submenu lists the versions to restore and, for an owner of the drive, ends with Delete history
// below them, outside the list's scroll area so a long list never hides it. Its dialog says how much it frees.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { formatFileSize } from '@workspace/lib/format';
import { DRIVE_MIME_DOC } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
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
const deleteVersions = mock(async () => {});

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realVersioning = { ...(await import('@workspace/lib/versioning')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
mock.module('@workspace/lib/versioning', () => ({
    ...realVersioning,
    useVersions: () => ({ data: versions }),
    useSaveVersion: () => ({ mutate: () => {}, isPending: false }),
    useDeleteVersions: () => ({ mutateAsync: deleteVersions }),
}));
mock.module('@workspace/lib/drive', () => ({ ...realDrive, useIsEffectiveOwner: () => isEffectiveOwner }));
afterAll(() => {
    mock.module('@workspace/lib/versioning', () => realVersioning);
    mock.module('@workspace/lib/drive', () => realDrive);
});

const { act, createElement } = await import('react');
const { DeleteHistoryDialog, VersionHistoryMenu } = await import(
    '../../../../components/layout/toolbar/version-history-menu'
);

const path = drivePath({ name: 'Plan', mimeType: DRIVE_MIME_DOC });

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    unmount = async () => {};
});

async function openVersionHistory(onRequestDeleteHistory = () => {}): Promise<Element | undefined> {
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
    const onRequestDeleteHistory = mock(() => {});
    const submenu = await openVersionHistory(onRequestDeleteHistory);

    const row = deleteRow(submenu);
    expect(row?.getAttribute('data-variant')).toBe('destructive');
    expect(submenu?.lastElementChild).toBe(row ?? null);
    expect(row?.previousElementSibling?.getAttribute('role')).toBe('separator');
    const list = submenu?.querySelector('.overflow-y-auto');
    expect(list?.querySelectorAll('[role="menuitem"]').length).toBe(versions.length);
    expect(row && list?.contains(row)).toBe(false);

    await clickRow('Delete history…');
    expect(onRequestDeleteHistory).toHaveBeenCalledTimes(1);
});

test('an editor who does not own the drive gets no Delete history', async () => {
    isEffectiveOwner = false;
    const submenu = await openVersionHistory();
    expect(submenu?.querySelectorAll('[role="menuitem"]').length).toBe(versions.length);
    expect(deleteRow(submenu)).toBeUndefined();
});

test('the dialog names the size of the listed versions and deletes on its button', async () => {
    deleteVersions.mockClear();
    ({ unmount } = await renderInDocument(createElement(DeleteHistoryDialog, { path, open: true, onClose: () => {} })));
    const dialog = document.querySelector('[role="dialog"]');
    const total = versions.reduce((sum, version) => sum + version.size, 0);

    expect(dialog?.querySelector('h2')?.textContent).toBe('Delete version history?');
    expect(dialog?.querySelector('p')?.textContent).toBe(
        `Frees ${formatFileSize(total)}. Earlier versions of this document and its comments can't be restored after ` +
            'this. Images and comments you deleted are removed once everyone has closed it, except those from the last ' +
            '3 days.',
    );
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === 'Delete history',
    );
    await act(async () => confirm?.click());
    expect(deleteVersions).toHaveBeenCalledTimes(1);
});
