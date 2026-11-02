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
