// The one-name dialog a Drive picker's New folder and every Rename open. Create waits for a name with more than spaces,
// Enter submits like the button, and the name goes on as typed. A save closes it, and a failed one stays open with the
// typed name kept. Every editor's File menu mounts the rename dialog closed, so the Location line's breadcrumb is read
// only once the dialog opens.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { DRIVE_MIME_DOC, DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { pressEnter } from '../../press-enter';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const requests: string[] = [];
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
        async (input: string | URL | Request) => {
            requests.push(input instanceof Request ? input.url : String(input));
            return Response.json([]);
        },
        { preconnect: fetch.preconnect },
    ),
);
afterAll(() => fetchSpy.mockRestore());

const { act, createElement, useState } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');
const { DriveItemNameDialog } = await import('../../../components/drive/drive-item-name-dialog');

// A mutation hook toasts its failure before the dialog sees it, and the dialog drops only a toasted error.
const toasted = (message: string) => {
    const failure = new Error(message);
    onMutationError(failure);
    return failure;
};

const onSave = mock(async (_name: string) => {});
const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(async () => {
    await unmount();
    requests.length = 0;
});
beforeEach(() => {
    onSave.mockReset();
    onSave.mockImplementation(async () => {});
    onOpenChange.mockClear();
});

async function render(open: boolean) {
    ({ unmount } = await renderInDocument(
        createElement(DriveItemNameDialog, {
            open,
            onOpenChange: () => {},
            onSave,
            type: 'File',
            path: drivePath({ name: 'Notes.eigendoc', mimeType: DRIVE_MIME_DOC }),
        }),
    ));
}

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
        path: drivePath({ name: 'Projects', type: 'folder', mimeType: DRIVE_MIME_FOLDER }),
    });
}

async function openNewFolder() {
    ({ unmount } = await renderInDocument(createElement(Harness)));
}

const dialog = () => document.querySelector('[role="dialog"]');
const button = (label: string) =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === label);
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

test('a closed dialog reads no breadcrumb', async () => {
    await render(false);
    expect(requests).toEqual([]);
});

test('an open dialog reads the breadcrumb of its path', async () => {
    await render(true);
    expect(requests).toEqual([expect.stringContaining('/path-1/breadcrumb')]);
});

test('New folder shows a labelled name field, Cancel and Create', async () => {
    await openNewFolder();
    expect(dialog()?.querySelector('h2')?.textContent).toBe('New folder');
    const label = document.querySelector(`label[for="${nameField().id}"]`);
    expect(label?.textContent).toBe('Folder name');
    expect(nameField().placeholder).toBe('Enter folder name');
    expect(nameField().value).toBe('');
    expect(dialog()?.textContent).toContain('Location');
    expect(button('Cancel')).toBeDefined();
    expect(button('Create')).toBeDefined();
});

test('Create waits for a name with more than spaces', async () => {
    await openNewFolder();
    expect(button('Create')?.disabled).toBe(true);
    await type('   ');
    expect(button('Create')?.disabled).toBe(true);
    await act(async () => pressEnter(nameField()));
    await settle();
    expect(onSave).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
});

test('Create hands the typed name on and closes once it is saved', async () => {
    await openNewFolder();
    await type('Invoices');
    await click(button('Create'));
    await settle();
    expect(onSave.mock.calls).toEqual([['Invoices']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('Enter in the name field submits like Create', async () => {
    await openNewFolder();
    await type('Invoices');
    await act(async () => pressEnter(nameField()));
    await settle();
    expect(onSave.mock.calls).toEqual([['Invoices']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a slow save keeps the Create label and waits with both buttons', async () => {
    let finish = () => {};
    onSave.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    await openNewFolder();
    await type('Invoices');
    await click(button('Create'));
    expect(button('Create')?.disabled).toBe(true);
    expect(button('Cancel')?.disabled).toBe(true);
    await act(async () => finish());
    await settle();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
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
                path: drivePath({ name: 'notes.txt', mimeType: 'text/plain' }),
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
                path: drivePath({ name: 'notes.txt', mimeType: 'text/plain' }),
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
                path: drivePath({ name: 'notes.txt', mimeType: 'text/plain' }),
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

test('a save that fails stays open with the typed name kept', async () => {
    onSave.mockImplementation(async () => {
        throw toasted('offline');
    });
    await openNewFolder();
    await type('Invoices');
    await click(button('Create'));
    await settle();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(nameField().value).toBe('Invoices');
    expect(button('Create')?.disabled).toBe(false);
});
