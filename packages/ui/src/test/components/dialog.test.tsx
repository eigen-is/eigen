// DialogDescription wraps a long unbroken word, such as a file name, instead of making the dialog scroll sideways.
// Over an open preview, a click outside a dialog or an Escape closes that dialog alone, and a dialog under the preview
// stays open. Which one a dialog is follows from where it sits in the document, with no prop to say so.
import { afterEach, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import('../../components/dialog');
const { isLayerAbove } = await import('../../hooks/use-dialog-open');

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    for (const overlay of document.querySelectorAll('[data-preview-overlay]')) overlay.remove();
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

// The file preview's overlay as the dialog sees it: an element on <body>, after every layer opened before it.
const showPreview = () => {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-preview-overlay', '');
    document.body.append(overlay);
};

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
// Cancelable, as a browser's is, so a dialog under the preview can refuse it.
const pressEscape = () =>
    act(async () => {
        document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
    });
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

test('over a preview, a click outside a dialog closes that dialog alone, also one stacked on another', async () => {
    const picker = mock((_open: boolean) => {});
    const newFolder = mock((_open: boolean) => {});
    // New folder opens once the picker is up, as it does when the user asks for it.
    let openNewFolder = () => {};
    function Picker() {
        const [newFolderOpen, setNewFolderOpen] = useState(false);
        openNewFolder = () => setNewFolderOpen(true);
        return dialog('Save to Drive', picker, dialog('New folder', newFolder, null, newFolderOpen));
    }
    showPreview();
    ({ unmount } = await renderInDocument(createElement(Picker)));
    await settle();
    await act(async () => openNewFolder());
    await settle();
    await clickTopOverlay();
    expect(newFolder.mock.calls).toEqual([[false]]);
    expect(picker).not.toHaveBeenCalled();
    await unmount();

    // Rename over the preview, with no dialog under it.
    const rename = mock((_open: boolean) => {});
    ({ unmount } = await renderInDocument(dialog('Rename', rename)));
    await settle();
    await clickTopOverlay();
    expect(rename.mock.calls).toEqual([[false]]);
});

test('a plain dialog opened over a preview takes its own Escape and paints above it', async () => {
    const rename = mock((_open: boolean) => {});
    showPreview();
    ({ unmount } = await renderInDocument(dialog('Rename', rename)));
    const preview = document.querySelector('[data-preview-overlay]');
    const content = document.querySelector('[data-slot="dialog-content"]');
    if (!preview || !content) throw new Error('no preview or no dialog');
    // Later in the document at the same z-index paints above.
    expect(isLayerAbove(preview, content)).toBe(true);
    expect(content.className).not.toMatch(/\bz-\[/);
    await pressEscape();
    expect(rename.mock.calls).toEqual([[false]]);
});

test('a dialog under an open preview ignores a click outside it and an Escape', async () => {
    const card = mock((_open: boolean) => {});
    ({ unmount } = await renderInDocument(dialog('Sticky', card)));
    showPreview();
    await settle();
    await clickTopOverlay();
    await pressEscape();
    expect(card).not.toHaveBeenCalled();

    // Once the preview is gone, the same dialog takes its Escape again.
    document.querySelector('[data-preview-overlay]')?.remove();
    await pressEscape();
    expect(card.mock.calls).toEqual([[false]]);
});
