// DialogDescription wraps a long unbroken word, such as a file name, instead of making the dialog scroll sideways. A
// click outside a dialog stacked on another closes the top one alone.
import { afterEach, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import('../../components/dialog');

let unmount = async () => {};
afterEach(async () => {
    await unmount();
});

test('the description breaks long words', async () => {
    ({ unmount } = await renderInDocument(
        createElement(
            Dialog,
            { open: true },
            createElement(
                DialogContent,
                null,
                createElement(DialogTitle, null, 'Import'),
                createElement(DialogDescription, null, `${'a'.repeat(200)}.ics`),
            ),
        ),
    ));
    expect(document.querySelector('[data-slot="dialog-description"]')?.classList.contains('break-words')).toBe(true);
});

const dialog = (title: string, onOpenChange: (open: boolean) => void, children?: ReactNode, open = true) =>
    createElement(
        Dialog,
        { open, onOpenChange },
        createElement(
            DialogContent,
            { 'aria-describedby': undefined },
            createElement(DialogTitle, null, title),
            children,
        ),
    );

// Radix starts listening for outside clicks a tick after the dialog opens.
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
// Radix waits for the click before it closes a dialog, so the whole press goes in.
const clickTopOverlay = async () => {
    const overlays = document.querySelectorAll('[data-slot="dialog-overlay"]');
    const overlay = overlays[overlays.length - 1];
    if (!overlay) throw new Error('no dialog is open');
    await act(async () => {
        overlay.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        overlay.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    await settle();
};

test('a click outside a dialog stacked on another closes the top one alone', async () => {
    const picker = mock((_open: boolean) => {});
    const newFolder = mock((_open: boolean) => {});
    // New folder opens once the picker is up, as it does when the user asks for it.
    let openNewFolder = () => {};
    function Picker() {
        const [newFolderOpen, setNewFolderOpen] = useState(false);
        openNewFolder = () => setNewFolderOpen(true);
        return dialog('Save to Drive', picker, dialog('New folder', newFolder, null, newFolderOpen));
    }
    ({ unmount } = await renderInDocument(createElement(Picker)));
    await settle();
    await act(async () => openNewFolder());
    await settle();
    await clickTopOverlay();
    expect(newFolder.mock.calls).toEqual([[false]]);
    expect(picker).not.toHaveBeenCalled();
});

// No dialog has a Radix trigger, so Radix alone would leave the focus on the page body when one closes. A dialog gives
// it back to what had it as the dialog opened, or, if that is gone, such as a row menu's item, to what took it next
// outside the dialog: the list the closing menu handed it back to.
const pressEscape = () =>
    act(async () => {
        (document.activeElement ?? document).dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
        );
    });

test('Escape from a dialog opened by a button gives the focus back to the button', async () => {
    let open = () => {};
    function Page() {
        const [isOpen, setOpen] = useState(false);
        open = () => setOpen(true);
        return createElement(
            'div',
            null,
            createElement('button', { 'data-opener': '' }, 'Rename'),
            dialog('Rename', setOpen, createElement('input', { autoFocus: true }), isOpen),
        );
    }
    ({ unmount } = await renderInDocument(createElement(Page)));
    document.querySelector<HTMLElement>('[data-opener]')?.focus();
    await act(async () => open());
    await settle();
    expect(document.activeElement?.tagName).toBe('INPUT');

    await pressEscape();
    await settle();
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(document.activeElement?.hasAttribute('data-opener')).toBe(true);
});

test('a dialog opened from a row’s menu gives the focus back to the list', async () => {
    const { ContextMenuAnchor, useContextMenu } = await import('../../components/context-menu');
    const { DropdownMenuItem } = await import('../../components/dropdown-menu');
    let openMenu = () => {};
    function Listing() {
        const [isOpen, setOpen] = useState(false);
        const menu = useContextMenu<string>();
        openMenu = () => menu.openAt('notes.txt', 0, 0);
        return createElement(
            'div',
            null,
            createElement('div', { tabIndex: 0, 'data-list': '' }, 'notes.txt'),
            createElement(ContextMenuAnchor, {
                contextMenu: menu,
                children: createElement(DropdownMenuItem, { onClick: () => setOpen(true) }, 'Rename'),
            }),
            dialog('Rename', setOpen, createElement('input', { autoFocus: true }), isOpen),
        );
    }
    ({ unmount } = await renderInDocument(createElement(Listing)));
    document.querySelector<HTMLElement>('[data-list]')?.focus();
    await act(async () => openMenu());
    await settle();
    const row = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (r) => r.textContent === 'Rename',
    );
    await act(async () => row?.click());
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement?.tagName).toBe('INPUT');

    await pressEscape();
    await settle();
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(document.activeElement?.hasAttribute('data-list')).toBe(true);
});

// The sheet's handler prevents the default even when it leaves the focus alone, because a press outside put it where
// the user wanted it.
test('a caller that prevents the default on close decides where the focus goes', async () => {
    let open = () => {};
    const keepFocus = (event: Event) => event.preventDefault();
    function Page() {
        const [isOpen, setOpen] = useState(false);
        open = () => setOpen(true);
        return createElement(
            'div',
            null,
            createElement('button', { 'data-opener': '' }, 'Insert'),
            createElement(
                Dialog,
                { open: isOpen, onOpenChange: setOpen },
                createElement(
                    DialogContent,
                    { 'aria-describedby': undefined, onCloseAutoFocus: keepFocus },
                    createElement(DialogTitle, null, 'Insert'),
                ),
            ),
        );
    }
    ({ unmount } = await renderInDocument(createElement(Page)));
    document.querySelector<HTMLElement>('[data-opener]')?.focus();
    await act(async () => open());
    await settle();
    await pressEscape();
    await settle();
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(document.activeElement?.hasAttribute('data-opener')).toBe(false);
});
