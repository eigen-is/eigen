// The Version history submenu lists the versions to restore and, for an owner of the drive, ends with Delete history
// below them, outside the list's scroll area so a long list never hides it. Its pick hands the dialog the size of the
// listed versions, so the dialog says how much it frees without a fetch of its own.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { formatDateTime } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import { DRIVE_MIME_DOC } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import type { ReactElement } from 'react';
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

const { act, createElement, useState } = await import('react');
const { DeleteHistoryDialog, RestoreVersionDialog, VersionHistoryMenu } = await import(
    '../../../../components/layout/toolbar/version-history-menu'
);

const path = drivePath({ name: 'Plan', mimeType: DRIVE_MIME_DOC });

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    unmount = async () => {};
});

const realGetComputedStyle = globalThis.getComputedStyle;
afterEach(() => {
    listed = versions;
    globalThis.getComputedStyle = realGetComputedStyle;
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
    ({ unmount } = await renderInDocument(createElement(DeleteHistoryDialog, { path, size, onClose: () => {} })));
    const dialog = document.querySelector('[role="dialog"]');

    expect(dialog?.querySelector('h2')?.textContent).toBe('Delete version history?');
    expect(dialog?.querySelector('p')?.textContent).toBe(
        `Frees ${formatFileSize(size)}. Earlier versions of this document and its comments can't be restored after ` +
            'this. Images and comments you deleted are removed once everyone has closed it, except those added or ' +
            'replied to in the last 3 days.',
    );
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === 'Delete history',
    );
    await act(async () => confirm?.click());
    expect(deleteVersions).toHaveBeenCalledTimes(1);
});

// Renders a dialog, cancels it and returns its text as it fades out. Radix keeps a closing dialog mounted while its
// animation runs. happy-dom computes no animation from a style sheet and never ends one, so the content reports a
// fade-out once it closes and stays.
async function textWhileClosing(dialogHarness: () => ReactElement): Promise<string | null | undefined> {
    globalThis.getComputedStyle = (element, pseudo) => {
        const style = realGetComputedStyle(element, pseudo);
        if (!(element instanceof HTMLElement) || element.dataset.slot !== 'dialog-content') return style;
        return new Proxy(style, {
            get: (target, key) =>
                key === 'animationName'
                    ? element.dataset.state === 'closed'
                        ? 'fade-out'
                        : 'fade-in'
                    : Reflect.get(target, key),
        });
    };
    ({ unmount } = await renderInDocument(createElement(dialogHarness)));
    const cancel = [...document.querySelectorAll('[role="dialog"] button')].find(
        (button) => button.textContent === 'Cancel',
    );
    await act(async () => cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('data-state')).toBe('closed');
    return dialog?.querySelector('p')?.textContent;
}

test('the dialog keeps naming the size while it closes', async () => {
    const size = 5 * 1024 * 1024;
    function Harness() {
        const [shown, setShown] = useState<number | null>(size);
        return createElement(DeleteHistoryDialog, { path, size: shown, onClose: () => setShown(null) });
    }
    expect(await textWhileClosing(Harness)).toStartWith(`Frees ${formatFileSize(size)}.`);
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

test('the restore dialog keeps naming the version while it closes', async () => {
    const [version] = versions;
    function Harness() {
        const [shown, setShown] = useState<Snapshot | null>(version ?? null);
        return createElement(RestoreVersionDialog, { path, snapshot: shown, onClose: () => setShown(null) });
    }
    expect(await textWhileClosing(Harness)).toContain(`the ${version && formatDateTime(version.createdAt)} version`);
});

test('the restore dialog says comments go back with their text and replies stay', async () => {
    ({ unmount } = await renderInDocument(
        createElement(RestoreVersionDialog, { path, snapshot: versions[0], onClose: () => {} }),
    ));
    const text = document.querySelector('[role="dialog"] p')?.textContent;
    expect(text).toContain("Comments go back with the text they're on. Their replies stay as they are now.");
    expect(text).not.toContain('attachments');
});
