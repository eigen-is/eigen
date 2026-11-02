// What the command palette offers for a Drive selection: the rows the item's menu draws, bound to the
// selection. Open runs the view's own open, a writable view offers the copy and move rows and Watch with
// its live state, and a private item has no collaborators to mail.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { PaletteSelectionActions } from '@workspace/lib/types/command-palette';
import type { DriveActionId, DriveCapabilities, DrivePath } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// One session object, as the real provider holds one: hooks keyed on it must not see a new user each render.
const session = { user: { id: 'owner-1', email: 'me@example.com' } };
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
// The Watch row reads the item's watch state from the server: here the item is watched directly.
const realDrive = { ...(await import('@workspace/lib/drive')) };
const idle = { isPending: false, mutate: () => {} };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useIsPathWatched: () => ({ data: { direct: true, viaAncestor: null } }),
    useWatchPath: () => idle,
    useUnwatchPath: () => idle,
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/drive', () => realDrive);
});

const { createElement } = await import('react');
const { driveActionsFor } = await import('@workspace/lib/drive');
const { useCommandPalette } = await import('@workspace/lib/command-palette');
const { CommandPaletteProvider } = await import(
    '../../../components/layout/app/command-palette/command-palette-provider'
);
const { PreviewProvider } = await import('../../../components/preview-provider');
const { DRIVE_CAPABILITIES } = await import('../../../components/drive/drive-capabilities');
const { DrivePaletteSelection } = await import('../../../components/drive/drive-palette-selection');

let unmount = async () => {};
// Each render unmounts the one before, so a test can open several in turn.
const unmountLast = async () => {
    await unmount();
    unmount = async () => {};
};
afterEach(unmountLast);

const folder = drivePath({
    id: 'folder-1',
    name: 'Photos',
    type: 'folder',
    mimeType: 'inode/directory',
    parentId: 'root',
});
const text = drivePath({ id: 'text-1', name: 'notes.txt', mimeType: 'text/plain', parentId: 'root' });
const csv = drivePath({ id: 'csv-1', name: 'sales.csv', mimeType: 'text/csv', parentId: 'root' });
const xlsx = drivePath({
    id: 'xlsx-1',
    name: 'sales.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    parentId: 'root',
});
const shared = drivePath({
    id: 'shared-1',
    name: 'Plan.txt',
    mimeType: 'text/plain',
    parentId: 'root',
    acl: [{ id: 'friend@example.com', read: true, write: false }],
});

// Publishes the selection through a runner drawn by hand, as DriveLayout's would gate it, and returns what
// the palette received and the Drive actions it ran.
async function publish(items: DrivePath[], capabilities: DriveCapabilities = DRIVE_CAPABILITIES.browse) {
    await unmountLast();
    const ran: [DriveActionId, DrivePath[]][] = [];
    const actions = {
        capabilities,
        actionsFor: (targets: readonly DrivePath[]) =>
            driveActionsFor({ items: targets, capabilities, sharedWithMe: false }),
        run: (id: DriveActionId, targets: DrivePath[]) => ran.push([id, targets]),
        onCreateEigenDoc: {},
        dialogs: null,
    };
    const received: { actions: PaletteSelectionActions } = { actions: null };
    function Reader() {
        received.actions = useCommandPalette().selectionActions;
        return null;
    }
    ({ unmount } = await renderInDocument(
        createElement(
            PreviewProvider,
            null,
            createElement(
                CommandPaletteProvider,
                null,
                createElement(DrivePaletteSelection, { items, listing: items, actions }),
                createElement(Reader),
            ),
        ),
    ));
    const rows = received.actions ?? [];
    return { ids: rows.map(({ action }) => action.id), rows, ran };
}

test('Open on a folder or a text file runs the view’s own open', async () => {
    for (const item of [folder, text]) {
        const { rows, ran } = await publish([item]);
        rows.find(({ action }) => action.id === 'open')?.run();
        expect(ran).toEqual([['open', [item]]]);
    }
});

test('a writable selection offers Duplicate, Move to…, Copy to… and Watch with its live label', async () => {
    const { ids, rows } = await publish([text]);
    expect(ids).toEqual(expect.arrayContaining(['duplicate', 'move-to', 'copy-to', 'watch']));
    expect(rows.find(({ action }) => action.id === 'watch')?.action.label).toBe('Stop watching');
});

test('a multi-selection offers the rows that act on a set, and no file actions', async () => {
    const { ids } = await publish([text, csv]);
    expect(ids).toEqual(expect.arrayContaining(['duplicate', 'move-to', 'copy-to', 'trash']));
    expect(ids).not.toContain('watch');
    expect(ids).not.toContain('quick-look');
});

test('Email collaborators only for an item someone else can see', async () => {
    expect((await publish([text])).ids).not.toContain('email-collaborators');
    expect((await publish([shared])).ids).toContain('email-collaborators');
});

test('the file actions come through the file runner, read-only in a read-only view', async () => {
    const writable = await publish([xlsx]);
    expect(writable.ids).toEqual(expect.arrayContaining(['quick-look', 'download', 'convert-to-sheet']));
    const readOnly = await publish([xlsx], DRIVE_CAPABILITIES.readOnly);
    expect(readOnly.ids).toEqual(expect.arrayContaining(['quick-look', 'download']));
    expect(readOnly.ids).not.toContain('convert-to-sheet');
    expect(readOnly.ids).not.toContain('rename');
});

test('the rows read in the item menu’s order', async () => {
    const { ids } = await publish([xlsx]);
    expect(ids.indexOf('open-new-tab')).toBe(-1);
    expect(ids.indexOf('quick-look')).toBeLessThan(ids.indexOf('rename'));
    expect(ids.indexOf('convert-to-sheet')).toBeLessThan(ids.indexOf('download'));
    expect(ids.indexOf('download')).toBeLessThan(ids.indexOf('share'));
    expect(ids.at(-1)).toBe('trash');
});
