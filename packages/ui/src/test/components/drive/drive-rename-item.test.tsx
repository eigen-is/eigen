// Rename shows a plain file's whole name with the part before the extension selected, and saves what the user typed,
// so the extension can change. An Eigen document's extension stays hidden and comes back on save, once, even when the
// user typed it. A folder keeps the name as typed. The save closes the dialog and reports the rename, and a failed save
// stays open with the typed name.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_DOC, DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { pressEnter } from '../../press-enter';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const renamePath = mock(async (_variables: { path: DrivePath; newName: string }) => {});
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realDrive = { ...(await import('@workspace/lib/drive')) };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useBreadcrumb: () => ({ data: [] }),
    useRenamePath: () => ({ mutateAsync: renamePath, isPending: false }),
}));
afterAll(() => {
    mock.module('@workspace/lib/drive', () => realDrive);
});

const { act, createElement, useState } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');
const { DriveRenameItem } = await import('../../../components/drive/drive-rename-item');

const toasted = (message: string) => {
    const failure = new Error(message);
    onMutationError(failure);
    return failure;
};

const onOpenChange = mock((_open: boolean) => {});
const onAfterAction = mock((_actionType: string, _data: Record<string, unknown>) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    renamePath.mockReset();
    renamePath.mockImplementation(async () => {});
    onOpenChange.mockClear();
    onAfterAction.mockClear();
});

const notes = drivePath({ id: 'notes', name: 'Notes.eigendoc', type: 'doc', mimeType: DRIVE_MIME_DOC });
const text = drivePath({ id: 'text', name: 'notes.txt', mimeType: 'text/plain' });
const folder = drivePath({ id: 'folder', name: 'a.b', type: 'folder', mimeType: DRIVE_MIME_FOLDER });

function Harness({ path }: { path: DrivePath }) {
    const [open, setOpen] = useState(true);
    return createElement(DriveRenameItem, {
        path,
        open,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            setOpen(next);
        },
        onAfterAction,
    });
}

async function open(path: DrivePath) {
    ({ unmount } = await renderInDocument(createElement(Harness, { path })));
}

const dialog = () => document.querySelector('[role="dialog"]');
const button = (label: string) =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === label);
const nameField = () => {
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
    if (!input) throw new Error('the dialog has no name field');
    return input;
};
const fieldLabel = () => document.querySelector(`label[for="${nameField().id}"]`)?.textContent;
const type = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(nameField(), value);
        nameField().dispatchEvent(new Event('input', { bubbles: true }));
    });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test("a document's rename asks for its name without the extension", async () => {
    await open(notes);
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Rename Notes');
    expect(fieldLabel()).toBe('File name');
    expect(nameField().placeholder).toBe('Enter file name');
    expect(nameField().value).toBe('Notes');
    expect(button('Rename')?.disabled).toBe(false);
});

test("a plain file's rename shows its whole name", async () => {
    await open(text);
    expect(fieldLabel()).toBe('File name');
    expect(nameField().value).toBe('notes.txt');
});

test("a folder's rename asks for the whole folder name", async () => {
    await open(folder);
    expect(fieldLabel()).toBe('Folder name');
    expect(nameField().placeholder).toBe('Enter folder name');
    expect(nameField().value).toBe('a.b');
});

test('Rename puts the extension back once, closes, and reports the rename', async () => {
    await open(notes);
    await type('Minutes.eigendoc');
    await act(async () => pressEnter(nameField()));
    await settle();
    expect(renamePath.mock.calls).toEqual([[{ path: notes, newName: 'Minutes.eigendoc' }]]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(onAfterAction.mock.calls).toEqual([['rename', { name: 'Minutes.eigendoc' }]]);
});

test("a document's typed name gets its extension back", async () => {
    await open(notes);
    await type('Renamed');
    await act(async () => button('Rename')?.click());
    await settle();
    expect(renamePath.mock.calls).toEqual([[{ path: notes, newName: 'Renamed.eigendoc' }]]);
});

test('a plain file is renamed to the name as typed, so its extension can change or go', async () => {
    for (const newName of ['notes.md', 'notes']) {
        await open(text);
        await type(newName);
        await act(async () => button('Rename')?.click());
        await settle();
        await unmount();
    }
    expect(renamePath.mock.calls).toEqual([[{ path: text, newName: 'notes.md' }], [{ path: text, newName: 'notes' }]]);
});

test('a folder is renamed to the name as typed', async () => {
    await open(folder);
    await type('c.d');
    await act(async () => button('Rename')?.click());
    await settle();
    expect(renamePath.mock.calls).toEqual([[{ path: folder, newName: 'c.d' }]]);
});

test('a rename that fails stays open with the typed name', async () => {
    renamePath.mockImplementation(async () => {
        throw toasted('taken');
    });
    await open(notes);
    await type('Minutes');
    await act(async () => button('Rename')?.click());
    await settle();
    expect(renamePath).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onAfterAction).not.toHaveBeenCalled();
    expect(nameField().value).toBe('Minutes');
});

// The palette's Rename opens the dialog with no menu around it, so no focus trap takes the focus back and selects the
// field. The dialog itself selects the name, so every path opens alike, ready for a new name to replace it.
test('the dialog opens with the name before the extension selected, or a name without one selected whole', async () => {
    const selections = [];
    for (const path of [
        text,
        drivePath({ name: 'README', mimeType: 'text/plain' }),
        drivePath({ name: '.env', mimeType: 'text/plain' }),
        notes,
        drivePath({ name: 'Plan v1.2.eigendoc', type: 'doc', mimeType: DRIVE_MIME_DOC }),
        folder,
    ]) {
        await open(path);
        await settle();
        const field = nameField();
        selections.push([document.activeElement === field, field.value, field.selectionStart, field.selectionEnd]);
        await unmount();
    }
    expect(selections).toEqual([
        [true, 'notes.txt', 0, 5],
        [true, 'README', 0, 6],
        [true, '.env', 0, 4],
        [true, 'Notes', 0, 5],
        [true, 'Plan v1.2', 0, 9],
        [true, 'a.b', 0, 3],
    ]);
});
