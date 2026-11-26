// A tooltip opens when its trigger takes the focus with a focus ring, as from a Tab, and not when a closing dialog
// gives the focus back to a button a mouse clicked. Such a tooltip would take the next Esc, so closing the dialog
// around it took two presses (Delete calendar's confirm over Edit calendar).
import { afterEach, expect, test } from 'bun:test';
import { recordFocus } from '../focus-calls';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { Dialog, DialogContent, DialogTitle } = await import('../../components/dialog');
const { ConfirmDialog } = await import('../../components/confirm-dialog');
const { TooltipButton } = await import('../../components/layout/toolbar/tooltip-button');
const { Trash2 } = await import('lucide-react');

let unmount = async () => {};
afterEach(async () => {
    await unmount();
});

// Radix starts listening for Esc and outside clicks a tick after a dialog opens.
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
const pressEscape = async () => {
    await act(async () => {
        (document.activeElement ?? document).dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
        );
    });
    await settle();
};
const tooltip = () => document.querySelector('[data-slot="tooltip-content"]');
const dialogs = () => document.querySelectorAll('[data-slot="dialog-content"]').length;

// Edit calendar with its trash button, which asks Delete calendar over it.
function EditCalendar() {
    const [open, setOpen] = useState(true);
    const [confirming, setConfirming] = useState(false);
    return createElement(
        Dialog,
        { open, onOpenChange: setOpen },
        createElement(
            DialogContent,
            { 'aria-describedby': undefined },
            createElement(DialogTitle, null, 'Edit calendar'),
            createElement('input', { autoFocus: true }),
            createElement(TooltipButton, {
                icon: Trash2,
                tooltipText: 'Delete calendar',
                onClick: () => setConfirming(true),
            }),
            createElement(ConfirmDialog, {
                open: confirming,
                onOpenChange: setConfirming,
                title: 'Delete calendar',
                description: 'Delete Work?',
                onConfirm: () => {},
            }),
        ),
    );
}

const renderTrash = async () => {
    ({ unmount } = await renderInDocument(createElement(EditCalendar)));
    await settle();
    const trash = document.querySelector<HTMLElement>('[aria-label="Delete calendar"]');
    if (!trash) throw new Error('no trash button');
    return trash;
};

test('Esc on the Delete calendar confirm, then Esc again closes Edit calendar', async () => {
    const trash = await renderTrash();
    recordFocus(trash, { withoutRing: true });
    await act(async () => {
        trash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
        trash.focus();
        trash.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
        trash.click();
    });
    await settle();
    expect(dialogs()).toBe(2);

    await pressEscape();
    expect(dialogs()).toBe(1);
    expect(document.activeElement).toBe(trash);
    expect(tooltip()).toBeNull();

    await pressEscape();
    expect(dialogs()).toBe(0);
});

test('a trigger the focus reaches with a ring shows its tooltip', async () => {
    const trash = await renderTrash();
    await act(async () => trash.focus());
    expect(tooltip()?.textContent).toContain('Delete calendar');
});
