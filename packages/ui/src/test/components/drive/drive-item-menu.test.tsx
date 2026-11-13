// The Drive item menu as a user reads it: which rows each kind of view offers on one item and on a
// multi-selection, with their labels. The rows come from the Drive action catalog and the file-action
// registry, so these cases pin what each gate shows.
import { afterEach, expect, mock, test } from 'bun:test';
import { fileActionsFor } from '@workspace/lib/file-actions';
import { subjectFromPath } from '@workspace/lib/file-subject';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveActionId } from '@workspace/lib/types/drive-actions';
import type { DriveCapabilities } from '@workspace/lib/types/drive-view';
import type { FileAction } from '@workspace/lib/types/file-subject';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { clickRow, menuRows, openSubmenu, renderOpenMenu } from '../../menu-rows';

installHappyDom();

// The Watch row reads the item's watch state from the server; nothing is watched here.
const realDrive = await import('@workspace/lib/drive');
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useWatchToggle: () => ({ direct: false, label: 'Watch', isPending: false, toggle: () => {} }),
}));

const { driveActionsFor } = await import('@workspace/lib/drive');
const { DRIVE_CAPABILITIES } = await import('../../../components/drive/drive-capabilities');
const { DriveItemMenuItems } = await import('../../../components/drive/drive-item-menu');

let unmount = async () => {};
afterEach(() => unmount());

const doc = drivePath({ name: 'Plan.eigendoc', mimeType: 'application/eigendoc', type: 'doc', parentId: 'root' });
const pdf = drivePath({ id: 'path-2', name: 'Report.pdf', mimeType: 'application/pdf', parentId: 'root' });

// A runner drawn by hand, as a host's hooks would build it for a viewer on a server with mail.
async function openMenu(items: DrivePath[], capabilities: DriveCapabilities, sharedWithMe = false, shortcuts = true) {
    const ran: DriveActionId[] = [];
    const actions = {
        capabilities,
        actionsFor: (targets: readonly DrivePath[]) =>
            driveActionsFor({ items: targets, capabilities, isSharedWithMe: () => sharedWithMe }),
        run: (id: DriveActionId) => ran.push(id),
        onCreateEigenDoc: {},
        dialogs: null,
    };
    const subject = items.length === 1 ? subjectFromPath(items[0], capabilities.canWrite) : null;
    const runner = {
        subject,
        actions: subject ? fileActionsFor(subject) : [],
        run: (_action: FileAction) => {},
        openPicker: () => {},
        dialogs: null,
        isPending: false,
    };
    const { createElement } = await import('react');
    ({ unmount } = await renderOpenMenu(createElement(DriveItemMenuItems, { items, actions, runner, shortcuts })));
    return ran;
}

function lastMenuRows(): string[] {
    const menu = [...document.querySelectorAll('[role="menu"]')].at(-1);
    return [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map((row) => row.textContent?.trim() ?? '');
}

test('browse offers one document every row, sharing in its submenu', async () => {
    await openMenu([doc], DRIVE_CAPABILITIES.browse);
    expect(menuRows()).toEqual([
        'Open',
        'Open in new tab',
        'Quick preview',
        '—',
        'Rename',
        'Duplicate',
        '—',
        'Move to…',
        'Copy to…',
        '—',
        'Download',
        '—',
        'Share',
        'Watch',
        '—',
        'Move to trash',
    ]);
    await openSubmenu('Share');
    expect(lastMenuRows()).toEqual(['Share', 'Copy link', 'Mail to…']);
});

test('a listing offers Duplicate but no Move to', async () => {
    await openMenu([pdf], DRIVE_CAPABILITIES.listing);
    expect(menuRows()).toEqual([
        'Quick preview',
        '—',
        'Rename',
        'Duplicate',
        '—',
        'Copy to…',
        '—',
        'Download',
        '—',
        'Share',
        'Watch',
        '—',
        'Move to trash',
    ]);
});

test('a read-only view keeps a Share submenu with only the link and the mail', async () => {
    await openMenu([doc], DRIVE_CAPABILITIES.readOnly);
    expect(menuRows()).toEqual([
        'Open',
        'Open in new tab',
        'Quick preview',
        '—',
        'Copy to…',
        '—',
        'Download',
        '—',
        'Share',
        'Watch',
    ]);
    await openSubmenu('Share');
    expect(lastMenuRows()).toEqual(['Copy link', 'Mail to…']);
});

test('an item shared with the viewer is removed, not trashed', async () => {
    await openMenu([pdf], DRIVE_CAPABILITIES.listing, true);
    expect(menuRows().at(-1)).toBe('Remove shared item');
});

test('a multi-selection counts its items in every row and can be mailed', async () => {
    const ran = await openMenu([doc, pdf], DRIVE_CAPABILITIES.browse);
    expect(menuRows()).toEqual([
        'Duplicate 2 items',
        '—',
        'Move 2 items to…',
        'Copy 2 items to…',
        '—',
        'Mail 2 items to…',
        '—',
        'Move 2 items to trash',
    ]);
    await clickRow('Mail 2 items to…');
    expect(ran).toEqual(['mail-to']);
});

test('a multi-selection shared with the viewer is removed', async () => {
    await openMenu([doc, pdf], DRIVE_CAPABILITIES.browse, true);
    expect(menuRows().at(-1)).toBe('Remove 2 shared items');
});

const shortcutHints = () => [...document.querySelectorAll('[data-slot="dropdown-menu-shortcut"]')];

// formatForDisplay draws Space and Backspace as these symbols on every platform. A touch screen hides them.
test('in a listing, Quick preview and the delete row name their keys', async () => {
    await openMenu([pdf], DRIVE_CAPABILITIES.browse);
    expect(shortcutHints().map((key) => [key.textContent, key.className.includes('pointer-coarse:hidden')])).toEqual([
        ['␣', true],
        ['⌫', true],
    ]);
});

test('a host whose keys don’t reach the listing, such as the detail column, names none', async () => {
    await openMenu([pdf], DRIVE_CAPABILITIES.browse, false, false);
    expect(shortcutHints()).toEqual([]);
});
