// The one-name dialog a Drive picker's New folder and every Rename open keeps the dialog contract. Create hands the
// name on as typed, a blank name says "Add a name" under the field, and a name a sibling has already shows the
// server's reason there until the name changes. The Location line names the folder it works in.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { AppError } from '@workspace/lib/api-error';
import { DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { expectFormContract } from '../../form-contract';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { DriveItemNameDialog } = await import('../../../components/drive/drive-item-name-dialog');

const onSave = mock(async (_name: string) => {});
const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    onSave.mockReset();
    onSave.mockImplementation(async () => {});
    onOpenChange.mockClear();
});

const ROOT = drivePath({ id: 'root', name: '', type: 'folder', mimeType: DRIVE_MIME_FOLDER });
const PROJECTS = drivePath({ id: 'projects', name: 'Projects', type: 'folder', mimeType: DRIVE_MIME_FOLDER });

// The dialog under a parent that owns `open`, as DriveBrowser does for its New folder.
function Harness() {
    const [open, setOpen] = useState(true);
    return createElement(DriveItemNameDialog, {
        open,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            setOpen(next);
        },
        onSave,
        type: 'Folder',
        folder: [ROOT, PROJECTS],
    });
}

async function openNewFolder() {
    ({ unmount } = await renderInDocument(createElement(Harness)));
}

const dialog = () => document.querySelector('[role="dialog"]');
// A pending button's spinner comes before its label.
const button = (label: string) =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (b) => b.lastChild?.textContent === label,
    );
const nameField = () => {
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
    if (!input) throw new Error('the dialog has no name field');
    return input;
};
const type = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(nameField(), value);
        nameField().dispatchEvent(new Event('input', { bubbles: true }));
    });
const click = (target: HTMLButtonElement | undefined) =>
    act(async () => {
        if (!target) throw new Error('nothing to click');
        target.click();
    });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('New folder keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => createElement(Harness),
        submitLabel: 'Create',
        firstField: 'Folder name',
        onSubmit: onSave,
        makeChanged: () => type('Invoices'),
        makeInvalid: () => type('   '),
        invalidField: 'Folder name',
    });
});

test('New folder shows a labelled name field and the folder it goes in', async () => {
    await openNewFolder();
    expect(dialog()?.querySelector('h2')?.textContent).toBe('New folder');
    const label = document.querySelector(`label[for="${nameField().id}"]`);
    expect(label?.textContent).toBe('Folder name');
    expect(nameField().placeholder).toBe('Enter folder name');
    expect(nameField().value).toBe('');
    expect(dialog()?.textContent).toContain('LocationDrive > Projects');
});

test('Create hands the typed name on and closes once it is saved', async () => {
    await openNewFolder();
    await type('Invoices');
    await click(button('Create'));
    await settle();
    expect(onSave.mock.calls).toEqual([['Invoices']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a name a sibling has already shows the reason under the field until the name changes', async () => {
    const taken = 'A file or folder named "Invoices" already exists in this directory';
    onSave.mockImplementation(async () => {
        throw new AppError({ status: 409, error: { status: 409, value: taken } });
    });
    await openNewFolder();
    await type('Invoices');
    await click(button('Create'));
    await settle();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(nameField());
    expect(dialog()?.querySelector('[data-slot="field-error"]')?.textContent).toBe(taken);
    await type('Invoices 2');
    expect(nameField().getAttribute('aria-invalid')).toBeNull();
    expect(dialog()?.querySelector('[data-slot="field-error"]')).toBeNull();
});

test('the name opens selected whole, or up to where the caller ends the selection', async () => {
    const selections = [];
    for (const selectionEnd of [undefined, 5]) {
        ({ unmount } = await renderInDocument(
            createElement(DriveItemNameDialog, {
                open: true,
                onOpenChange: () => {},
                onSave,
                type: 'File',
                folder: [ROOT],
                defaultValue: 'notes.txt',
                selectionEnd,
            }),
        ));
        await settle();
        selections.push([nameField().selectionStart, nameField().selectionEnd]);
        await unmount();
    }
    expect(selections).toEqual([
        [0, 9],
        [0, 5],
    ]);
});

// A menu row opens the dialog while the closing menu still traps the focus. The field must hold the focus and the
// selection the caller asked for once the menu is gone, not have its whole name selected by a trap that took it back.
test('opened from a context menu row, the field has the focus and the selection the caller asked for', async () => {
    const { ContextMenuAnchor } = await import('../../../components/context-menu/context-menu-anchor');
    const { useContextMenu } = await import('../../../components/context-menu/use-context-menu');
    const { DropdownMenuItem } = await import('../../../components/dropdown-menu');
    let openMenu = () => {};
    function Listing() {
        const menu = useContextMenu<string>();
        const [renaming, setRenaming] = useState(false);
        openMenu = () => menu.openAt('notes.txt', 0, 0);
        return createElement(
            'div',
            null,
            createElement('div', { tabIndex: 0, 'data-list': '' }, 'notes.txt'),
            createElement(ContextMenuAnchor, {
                contextMenu: menu,
                children: createElement(DropdownMenuItem, { onClick: () => setRenaming(true) }, 'Rename'),
            }),
            createElement(DriveItemNameDialog, {
                open: renaming,
                onOpenChange: setRenaming,
                onSave,
                type: 'File',
                folder: [ROOT],
                defaultValue: 'notes.txt',
                selectionEnd: 5,
            }),
        );
    }
    ({ unmount } = await renderInDocument(createElement(Listing)));
    document.querySelector<HTMLElement>('[data-list]')?.focus();
    await act(async () => openMenu());
    await settle();
    const rename = document.querySelector<HTMLElement>('[role="menuitem"]');
    await act(async () => rename?.click());
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(nameField());
    expect([nameField().selectionStart, nameField().selectionEnd]).toEqual([0, 5]);
});

// A ⋮ with a trigger of its own, such as the detail column's, as a mouse uses it. As it closes, the menu gives the
// focus back to that ⋮, and while it animates out the dialog covers its row and the pointer leaves the row. Either
// would move the focus out of the dialog, whose trap would take it back and select the whole name.
async function renameFromKebab() {
    const { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } = await import(
        '../../../components/dropdown-menu'
    );
    function Detail() {
        const [renaming, setRenaming] = useState(false);
        return createElement(
            'div',
            null,
            createElement(
                DropdownMenu,
                null,
                createElement(DropdownMenuTrigger, null, '⋮'),
                createElement(
                    DropdownMenuContent,
                    null,
                    createElement(DropdownMenuItem, { onClick: () => setRenaming(true) }, 'Rename'),
                ),
            ),
            createElement(DriveItemNameDialog, {
                open: renaming,
                onOpenChange: setRenaming,
                onSave,
                type: 'File',
                folder: [ROOT],
                defaultValue: 'notes.txt',
                selectionEnd: 5,
            }),
        );
    }
    ({ unmount } = await renderInDocument(createElement(Detail)));
    const trigger = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-trigger"]');
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    });
    await settle();
    const rename = document.querySelector<HTMLElement>('[role="menuitem"]');
    await act(async () => rename?.click());
    await settle();
    return rename;
}

test('opened from a ⋮ menu, the field keeps the focus and the selection as the menu gives its trigger the focus back', async () => {
    await renameFromKebab();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(nameField());
    expect([nameField().selectionStart, nameField().selectionEnd]).toEqual([0, 5]);
});

test('opened from a ⋮ menu, the field keeps the selection as the pointer leaves the closing menu’s row', async () => {
    // An exit animation keeps the closed menu on the page until it ends, which happy-dom never reports.
    const exit = document.head.appendChild(document.createElement('style'));
    exit.textContent = '[role="menu"][data-state="closed"] { animation-name: exit; }';
    const rename = await renameFromKebab();
    expect(document.querySelector('[role="menu"]')?.getAttribute('data-state')).toBe('closed');
    // React reads a pointer leaving the row from the pointerout it sends to what now lies under the pointer.
    await act(async () => {
        rename?.dispatchEvent(
            new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: nameField() }),
        );
    });
    await settle();
    exit.remove();
    expect(document.activeElement).toBe(nameField());
    expect([nameField().selectionStart, nameField().selectionEnd]).toEqual([0, 5]);
});
