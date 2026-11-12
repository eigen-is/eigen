// The folder browser inside the pickers, drawn for real under its real hosts: a folder picker such as Move to, the
// Location field alone, and the file picker. Each opens where its host says, or at the drive's root, a folder or a
// mount click moves it and the host's confirm gets that place, a host that moves moves the browser, and New folder
// creates in the folder shown. Only the Drive reads are faked, by a small tree held here.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import type { DriveLocationValue } from '../../../components/drive/drive-location-field';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const ME = 'me';
const TEAM = 'team_team-design';
const TEAM_MOUNT = 'design-drive';
const folder = (id: string, name: string, parentId: string | null, ownerId = ME, mountId = 'default') =>
    drivePath({ id, name, parentId, ownerId, mountId, mimeType: DRIVE_MIME_FOLDER, type: 'folder' });
const notes = drivePath({ id: 'notes', name: 'Notes.txt', parentId: 'root', ownerId: ME, mimeType: 'text/plain' });
const TREE = [
    folder('root', 'Drive', null),
    folder('docs', 'Docs', 'root'),
    folder('plans', 'Plans', 'docs'),
    folder('q3', 'Q3', 'plans'),
    notes,
    folder('design-root', 'Design drive', null, TEAM, TEAM_MOUNT),
    folder('briefs', 'Briefs', 'design-root', TEAM, TEAM_MOUNT),
];
let tree: DrivePath[] = [];
// The mounts whose root has not loaded yet.
const loadingRoots = new Set<string>();
const created: unknown[] = [];
beforeEach(() => {
    tree = [...TREE];
    loadingRoots.clear();
    created.length = 0;
});

const inDrive = (ownerId: string, mountId: string) =>
    tree.filter((p) => p.ownerId === ownerId && p.mountId === mountId);
function chain(ownerId: string, mountId: string, id: string): DrivePath[] {
    const path = inDrive(ownerId, mountId).find((p) => p.id === id);
    if (!path) return [];
    return path.parentId ? [...chain(ownerId, mountId, path.parentId), path] : [path];
}

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realHome = { ...(await import('@workspace/lib/home')) };
const session = { user: { id: ME } };
const teams = [{ id: 'team-design', name: 'Design', mounts: [{ id: TEAM_MOUNT, name: 'Design drive' }], members: [] }];
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useDriveViewPreferences: () => ({ sortKey: 'name', sortDir: 'asc' }),
    useSharedPaths: () => ({ data: [] }),
    useRootFolder: (ownerId: string, mountId: string) => ({
        data: loadingRoots.has(mountId) ? undefined : inDrive(ownerId, mountId).find((p) => p.parentId === null),
    }),
    useFolderContent: (ownerId: string, mountId: string, id: string) => ({
        data: id ? inDrive(ownerId, mountId).filter((p) => p.parentId === id) : undefined,
    }),
    useBreadcrumb: (ownerId: string, mountId: string, id: string | undefined) => ({
        data: id ? chain(ownerId, mountId, id) : undefined,
    }),
    useCreateFolder: () => ({
        mutateAsync: async (variables: { ownerId: string; mountId: string; parentId: string; folderName: string }) => {
            created.push(variables);
            const made = folder('made', variables.folderName, variables.parentId, variables.ownerId, variables.mountId);
            tree.push(made);
            return made;
        },
    }),
}));
mock.module('@workspace/lib/home', () => ({ ...realHome, useMyTeams: () => ({ data: teams }) }));
// happy-dom lays nothing out, and the table's virtualizer draws no row in a scroller 0 px tall.
const elementPrototype = HTMLElement.prototype;
const clientHeight = Object.getOwnPropertyDescriptor(elementPrototype, 'clientHeight');
Object.defineProperty(elementPrototype, 'clientHeight', { configurable: true, get: () => 600 });
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/home', () => realHome);
    if (clientHeight) Object.defineProperty(elementPrototype, 'clientHeight', clientHeight);
});

const { act, createElement, useState } = await import('react');
const { DriveFilePicker } = await import('../../../components/drive/drive-file-picker');
const { DriveLocationField } = await import('../../../components/drive/drive-location-field');
const { DriveLocationPicker } = await import('../../../components/drive/drive-location-picker');

let unmount = async () => {};
afterEach(() => unmount());

const rows = () => [...document.querySelectorAll('[role="row"].eigen-list-item')];
const rowNames = () => rows().map((row) => row.querySelector('.truncate')?.textContent);
// The crumbs of the first crumb row drawn: the Location bar's in a folder picker, the browser's own in the file picker.
const crumbs = () =>
    [...(document.querySelector('[data-slot="breadcrumb-list"]')?.querySelectorAll('a, [aria-current]') ?? [])].map(
        (crumb) => crumb.textContent,
    );
const buttonNamed = (label: string) => {
    const found = [...document.querySelectorAll('button')].filter(
        (b) => b.textContent === label || b.getAttribute('aria-label') === label,
    );
    const button = found.at(-1);
    if (!button) throw new Error(`no ${label} button`);
    return button;
};
const click = (target: Element | undefined) =>
    act(async () => {
        if (!target) throw new Error('nothing to click');
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
const clickRow = (name: string) => click(rows()[rowNames().indexOf(name)]);
const clickCrumb = (name: string) =>
    click([...document.querySelectorAll('[data-slot="breadcrumb-link"]')].find((c) => c.textContent === name));
const activeMount = () => document.querySelector('button.text-primary')?.textContent;

// A folder picker as Move to, Copy to and Save to Drive open it. `moveTo` is its host opening it somewhere else.
type Defaults = { defaultOwnerId?: string; defaultMountId?: string; defaultFolderId?: string };
const onConfirm = mock((_location: DriveLocationValue & { name?: string }) => {});
let moveTo: (defaults: Defaults) => void = () => {};
function FolderPickerHost({ defaults }: { defaults: Defaults }) {
    const [current, setCurrent] = useState(defaults);
    moveTo = setCurrent;
    return createElement(DriveLocationPicker, {
        open: true,
        onOpenChange: () => {},
        mode: 'folder',
        onConfirm,
        ...current,
    });
}
async function openFolderPicker(defaults: Defaults = {}) {
    onConfirm.mockClear();
    ({ unmount } = await renderInDocument(createElement(FolderPickerHost, { defaults })));
}
// What the picker's confirm button hands its host now.
async function confirmed() {
    onConfirm.mockClear();
    await click(buttonNamed('Select'));
    return onConfirm.mock.calls.map(([location]) => location);
}

test('a folder picker opens in the folder its host names', async () => {
    await openFolderPicker({ defaultFolderId: 'docs' });
    expect(rowNames()).toEqual(['Plans']);
    expect(crumbs()).toEqual(['Drive', 'Docs']);
    expect(activeMount()).toBe('Drive');
    expect(await confirmed()).toEqual([{ ownerId: ME, mountId: 'default', folderId: 'docs' }]);
});

test('a folder picker with no folder named opens at the root, and confirms the root', async () => {
    await openFolderPicker();
    expect(rowNames()).toEqual(['Docs', 'Notes.txt']);
    expect(crumbs()).toEqual(['Drive']);
    expect(await confirmed()).toEqual([{ ownerId: ME, mountId: 'default', folderId: 'root' }]);
});

test('a folder picker opens in another drive when its host names one', async () => {
    await openFolderPicker({ defaultOwnerId: TEAM, defaultMountId: TEAM_MOUNT });
    expect(rowNames()).toEqual(['Briefs']);
    expect(activeMount()).toBe('Design drive');
    expect(await confirmed()).toEqual([{ ownerId: TEAM, mountId: TEAM_MOUNT, folderId: 'design-root' }]);
});

test('a click on a folder opens it, and the picker confirms it', async () => {
    await openFolderPicker();
    await clickRow('Docs');
    expect(rowNames()).toEqual(['Plans']);
    expect(crumbs()).toEqual(['Drive', 'Docs']);
    expect(await confirmed()).toEqual([{ ownerId: ME, mountId: 'default', folderId: 'docs' }]);
    // A file is no destination: its row does nothing.
    await clickCrumb('Drive');
    await clickRow('Notes.txt');
    expect(rowNames()).toEqual(['Docs', 'Notes.txt']);
    expect(await confirmed()).toEqual([{ ownerId: ME, mountId: 'default', folderId: 'root' }]);
});

test('a click on a mount opens that drive at its root, and the picker confirms the root', async () => {
    await openFolderPicker({ defaultFolderId: 'docs' });
    await click(buttonNamed('Design drive'));
    expect(rowNames()).toEqual(['Briefs']);
    expect(crumbs()).toEqual(['Design drive']);
    expect(activeMount()).toBe('Design drive');
    expect(await confirmed()).toEqual([{ ownerId: TEAM, mountId: TEAM_MOUNT, folderId: 'design-root' }]);
    await clickRow('Briefs');
    expect(await confirmed()).toEqual([{ ownerId: TEAM, mountId: TEAM_MOUNT, folderId: 'briefs' }]);
});

test('a click on the mount the browser is in goes back to its root', async () => {
    await openFolderPicker({ defaultFolderId: 'plans' });
    await click(buttonNamed('Drive'));
    expect(rowNames()).toEqual(['Docs', 'Notes.txt']);
    expect(await confirmed()).toEqual([{ ownerId: ME, mountId: 'default', folderId: 'root' }]);
});

test('a host that names another folder or drive moves the browser there', async () => {
    await openFolderPicker({ defaultFolderId: 'docs' });
    await act(async () => moveTo({ defaultFolderId: 'plans' }));
    expect(rowNames()).toEqual(['Q3']);
    expect(crumbs()).toEqual(['Drive', 'Docs', 'Plans']);
    await act(async () => moveTo({ defaultOwnerId: TEAM, defaultMountId: TEAM_MOUNT }));
    expect(rowNames()).toEqual(['Briefs']);
    expect(activeMount()).toBe('Design drive');
    expect(await confirmed()).toEqual([{ ownerId: TEAM, mountId: TEAM_MOUNT, folderId: 'design-root' }]);
});

test('New folder creates in the folder shown, and the browser moves into the new folder', async () => {
    await openFolderPicker({ defaultFolderId: 'docs' });
    await click(buttonNamed('New folder'));
    const name = document.querySelector<HTMLInputElement>('#itemName');
    if (!name) throw new Error('New folder asked for no name');
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'Drafts');
        name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => buttonNamed('Create').click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(created).toEqual([{ ownerId: ME, mountId: 'default', parentId: 'docs', folderName: 'Drafts' }]);
    expect(document.querySelector('#itemName')).toBeNull();
    expect(crumbs()).toEqual(['Drive', 'Docs', 'Drafts']);
    expect(rowNames()).toEqual([]);
    expect(await confirmed()).toEqual([{ ownerId: ME, mountId: 'default', folderId: 'made' }]);
});

// The Location field alone, under a host that holds its value, as the new chat dialog does.
const onChange = mock((_value: DriveLocationValue) => {});
async function openField(value: DriveLocationValue) {
    onChange.mockClear();
    ({ unmount } = await renderInDocument(
        createElement(DriveLocationField, { value, onChange, expanded: true, onExpandedChange: () => {} }),
    ));
}

test('a folder click reports the owner, the mount and the folder, once', async () => {
    await openField({ ownerId: ME, mountId: 'default', folderId: 'docs' });
    expect(onChange.mock.calls).toEqual([]);
    await clickRow('Plans');
    expect(onChange.mock.calls).toEqual([[{ ownerId: ME, mountId: 'default', folderId: 'plans' }]]);
});

// The file picker, as File > Open and the imports open it.
const onSelect = mock((_paths: DrivePath[]) => {});
async function openFilePicker() {
    onSelect.mockClear();
    ({ unmount } = await renderInDocument(
        createElement(DriveFilePicker, { open: true, onOpenChange: () => {}, onSelect }),
    ));
}

test('the file picker opens at the root of the viewer’s drive, with no New folder', async () => {
    await openFilePicker();
    expect(rowNames()).toEqual(['Docs', 'Notes.txt']);
    expect(crumbs()).toEqual(['Drive']);
    expect(activeMount()).toBe('Drive');
    expect([...document.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('New folder');
});

test('the file picker walks folders, crumbs and mounts, and Select hands back the picked file', async () => {
    await openFilePicker();
    await clickRow('Docs');
    expect(rowNames()).toEqual(['Plans']);
    expect(crumbs()).toEqual(['Drive', 'Docs']);
    await clickCrumb('Drive');
    expect(rowNames()).toEqual(['Docs', 'Notes.txt']);
    await click(buttonNamed('Design drive'));
    expect(rowNames()).toEqual(['Briefs']);
    expect(crumbs()).toEqual(['Design drive']);
    await click(buttonNamed('Drive'));
    await clickRow('Notes.txt');
    await click(buttonNamed('Select'));
    expect(onSelect.mock.calls).toEqual([[[notes]]]);
});
