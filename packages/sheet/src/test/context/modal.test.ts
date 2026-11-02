// The sheet's modal host. A dialog in it draws its own FormDialog, renders as the only dialog, closes through its own
// opening, and keeps its mouse events from the handlers above the host. A close from an opening the slot no longer
// holds does nothing, so a submit that opens a confirm leaves the confirm open. The range picker's onClose runs once,
// whether it closes or another dialog takes its place, and says which. However a dialog closes, the focus goes
// back to the grid's keyboard target, unless another dialog took the slot. The range picker opens at a viewport
// point the caller computed, so the host clamps it on screen: a picker larger than the viewport pins to the top-left
// margin instead of being pushed off the opposite edge.

import { describe, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

// The module pulls in Radix, whose layout-effect shim picks a no-op when it first evaluates without a
// document, and later test files in this process would inherit it.
installHappyDom();

const { act, createElement, useContext } = await import('react');
const { renderInDocument } = await import('@workspace/ui/test/render-in-document');
const { FormDialog, FormDialogForm } = await import('@workspace/ui/components/form-dialog');
const { Input } = await import('@workspace/ui/components/input');
const { clampToViewport, ModalContext, ModalProvider, VIEWPORT_MARGIN } = await import('../../context/modal');
const { useDialog, useDialogProps } = await import('../../hooks/useDialog');
const { renderSheetDialog } = await import('../components/sheet-dialog');
type DialogAction = import('@workspace/ui/hooks/use-dialog-pending').DialogAction;

const VIEWPORT = { width: 1200, height: 800 };

describe('clampToViewport', () => {
    test('a dialog taller than the viewport pins to the top-left margin, not off the far edge', () => {
        expect(clampToViewport({ left: 344, top: 216 }, { width: 380, height: 900 }, VIEWPORT)).toEqual({
            left: 344,
            top: VIEWPORT_MARGIN,
        });
    });
});

// A dialog on FormDialog as the sheet's dialogs are: its open and close come from its opening.
function Rename({ onSubmit = () => {} }: { onSubmit?: DialogAction }) {
    return createElement(FormDialog, {
        ...useDialogProps(),
        title: 'Rename',
        children: createElement(FormDialogForm, {
            submitLabel: 'Save',
            onSubmit,
            children: createElement(Input, { 'aria-label': 'Name', defaultValue: 'Notes' }),
        }),
    });
}

const pressed = mock((_type: string) => {});

type Host = { host?: import('react').ContextType<typeof ModalContext>; dialogs?: ReturnType<typeof useDialog> };

function Opener({ opened }: { opened: Host }) {
    opened.host = useContext(ModalContext);
    opened.dialogs = useDialog();
    return null;
}

// The host under an element whose React handlers see every mouse event that bubbles up the component tree, as the
// workbook's ancestors would.
async function renderHost() {
    pressed.mockClear();
    const opened: Host = {};
    await renderInDocument(
        createElement(
            'div',
            {
                onMouseDown: () => pressed('mousedown'),
                onMouseMove: () => pressed('mousemove'),
                onMouseUp: () => pressed('mouseup'),
                onContextMenu: () => pressed('contextmenu'),
            },
            createElement(ModalProvider, null, createElement(Opener, { opened })),
        ),
    );
    const { host, dialogs } = opened;
    if (!host || !dialogs) throw new Error('the host did not render');
    return { host, dialogs };
}

const openDialogs = () => [...document.querySelectorAll('[role="dialog"]')];
const title = () => document.querySelector('[role="dialog"] h2')?.textContent;
const click = (target: Element | null | undefined) =>
    act(async () => {
        if (!(target instanceof HTMLElement)) throw new Error('nothing to click');
        target.click();
    });
const button = (label: string) =>
    [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === label);

describe('a FormDialog in the host', () => {
    test('is the only dialog, with its corner X, and the X closes it', async () => {
        const { dialogs } = await renderHost();
        await act(async () => dialogs.showDialog(createElement(Rename)));
        expect(openDialogs()).toHaveLength(1);
        expect(title()).toBe('Rename');
        await click(document.querySelector('[data-slot="dialog-close"]'));
        expect(openDialogs()).toHaveLength(0);
    });

    test('a submit that opens another dialog leaves that one open', async () => {
        const { dialogs } = await renderHost();
        await act(async () =>
            dialogs.showDialog(createElement(Rename, { onSubmit: () => dialogs.showDialog('Replace it?', 'yesno') })),
        );
        await click(button('Save'));
        expect(title()).toBe('Notice');
        expect(openDialogs()).toHaveLength(1);
    });

    test('a press, a drag and a right click inside it reach no handler above the host', async () => {
        const { dialogs } = await renderHost();
        await act(async () => dialogs.showDialog(createElement(Rename)));
        const input = document.querySelector('[role="dialog"] input');
        if (!input) throw new Error('no field');
        await act(async () => {
            for (const type of ['mousedown', 'mousemove', 'mouseup', 'contextmenu']) {
                input.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
            }
        });
        expect(pressed).not.toHaveBeenCalled();
    });
});

describe("the range picker's onClose", () => {
    test('runs once when the picker closes, however often it is hidden', async () => {
        const { host } = await renderHost();
        const onClose = mock((_reason: string) => {});
        await act(async () => host.showNonModal('Pick a range', { onClose }));
        await act(async () => {
            host.hideModal();
            host.hideModal();
        });
        expect(onClose.mock.calls).toEqual([['closed']]);
    });

    test('runs once when another dialog takes the slot, and not again when that one closes', async () => {
        const { host } = await renderHost();
        const onClose = mock((_reason: string) => {});
        await act(async () => host.showNonModal('Pick a range', { onClose }));
        await act(async () => host.showModal('A notice'));
        expect(onClose.mock.calls).toEqual([['replaced']]);
        await act(async () => host.hideModal());
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe("the range picker's shell", () => {
    // The app's stylesheet fades a closing dialog out, and Radix keeps it in the document until the fade ends.
    test('leaves no empty shell on screen while the picker fades out', async () => {
        const fade = document.createElement('style');
        fade.textContent = '[role="dialog"][data-state="closed"] { animation-name: fade-out; }';
        document.head.append(fade);
        try {
            const { host } = await renderHost();
            await act(async () => host.showNonModal('Pick a range', {}));
            await act(async () => host.hideModal());
            expect(openDialogs()).toHaveLength(0);
        } finally {
            fade.remove();
        }
    });

    test('keeps a picker anchored past the viewport edge on screen', async () => {
        const { host } = await renderHost();
        await act(async () => host.showNonModal('Pick a range', { anchor: { left: 5000, top: 5000 } }));
        const [picker] = openDialogs();
        if (!(picker instanceof HTMLElement)) throw new Error('no picker');
        expect(picker.style.left).toBe(`${window.innerWidth - VIEWPORT_MARGIN}px`);
        expect(picker.style.top).toBe(`${window.innerHeight - VIEWPORT_MARGIN}px`);
    });
});

// Radix hands the focus on a moment after a dialog unmounts.
const focusSettled = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

const pressEscape = () =>
    act(async () => {
        document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
    });

describe('the focus after a dialog closes', () => {
    const renderRename = () => renderSheetDialog((d) => d.showDialog(createElement(Rename)));

    test('goes back to the grid on Cancel', async () => {
        const dialog = await renderRename();
        await dialog.click('Cancel');
        await focusSettled();
        expect(document.activeElement?.id).toBe('sheet-rich-text-editor');
    });

    test('goes back to the grid on Escape', async () => {
        const dialog = await renderRename();
        await pressEscape();
        expect(dialog.dialogs()).toHaveLength(0);
        await focusSettled();
        expect(document.activeElement?.id).toBe('sheet-rich-text-editor');
    });

    test('goes back to the grid on a submit', async () => {
        const dialog = await renderRename();
        await dialog.click('Save');
        await focusSettled();
        expect(document.activeElement?.id).toBe('sheet-rich-text-editor');
    });

    test('stays in the confirm a submit opened', async () => {
        const dialog = await renderSheetDialog((d) =>
            d.showDialog(createElement(Rename, { onSubmit: () => d.showDialog('Replace it?', 'yesno') })),
        );
        await dialog.click('Save');
        await focusSettled();
        const [confirm] = dialog.dialogs();
        expect(dialog.title()).toBe('Notice');
        expect(confirm?.contains(document.activeElement)).toBe(true);
    });

    // The picker leaves the grid usable, so no focus trap would pull the focus back to it.
    test('stays in the range picker a dialog opened in its place', async () => {
        const dialog = await renderSheetDialog((d) =>
            d.showDialog(createElement(Rename, { onSubmit: () => d.showNonModalDialog('Pick a range', {}) })),
        );
        await dialog.click('Save');
        await focusSettled();
        const [picker] = dialog.dialogs();
        expect(picker?.textContent).toBe('Pick a range');
        expect(picker?.contains(document.activeElement)).toBe(true);
    });
});
