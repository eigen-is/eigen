// The sheet's modal host. A dialog on FormDialog renders as the only dialog, closes through its own opening, and keeps
// its mouse events from the handlers above the host, as the shell around the other dialogs does. A close from an
// opening the slot no longer holds does nothing, so a submit that opens a confirm leaves the confirm open. The anchored
// dialog (the cell-range picker) opens at a viewport point the caller computed, so the host clamps it on screen: a
// dialog larger than the viewport pins to the top-left margin instead of being pushed off the opposite edge.

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
        await act(async () => dialogs.showFormDialog(createElement(Rename)));
        expect(openDialogs()).toHaveLength(1);
        expect(title()).toBe('Rename');
        await click(document.querySelector('[data-slot="dialog-close"]'));
        expect(openDialogs()).toHaveLength(0);
    });

    test('a submit that opens another dialog leaves that one open', async () => {
        const { dialogs } = await renderHost();
        await act(async () =>
            dialogs.showFormDialog(
                createElement(Rename, { onSubmit: () => dialogs.showDialog('Replace it?', 'yesno') }),
            ),
        );
        await click(button('Save'));
        expect(title()).toBe('Notice');
        expect(openDialogs()).toHaveLength(1);
    });

    test('a press, a drag and a right click inside it reach no handler above the host', async () => {
        const { dialogs } = await renderHost();
        await act(async () => dialogs.showFormDialog(createElement(Rename)));
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

test('a dialog that leaves the grid usable runs its onClose once, however often it is hidden', async () => {
    const { host } = await renderHost();
    const onClose = mock(() => {});
    await act(async () => host.showModal('Pick a range', { modal: false, onClose }));
    await act(async () => {
        host.hideModal();
        host.hideModal();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
});
