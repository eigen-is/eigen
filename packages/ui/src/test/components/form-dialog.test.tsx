// A form dialog submits on Enter as on its submit button, and only when the caller says the fields are valid. While a
// submit runs, its buttons and every way to close it wait. It closes once the submit succeeds and stays open when it
// fails or returns false, for another try. A dialog that is closing takes no second submit, and a dialog opened from
// inside another form never submits that form.
import { afterEach, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import type { DialogAction } from '../../hooks/use-dialog-pending';
import { installHappyDom } from '../happy-dom';
import { pressEnter } from '../press-enter';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');
const { FormDialog, FormDialogForm } = await import('../../components/form-dialog');
const { Input } = await import('../../components/input');
const { ABOVE_PREVIEW_Z } = await import('../../components/dialog');
const { PreviewContext } = await import('../../components/preview-provider/preview-context');

let unmount = async () => {};
const realGetComputedStyle = globalThis.getComputedStyle;
afterEach(async () => {
    await unmount();
    globalThis.getComputedStyle = realGetComputedStyle;
});

const onOpenChange = mock((_open: boolean) => {});

async function render({
    onSubmit = () => {},
    canSubmit,
    footerStart,
    readOnly,
    description,
}: {
    onSubmit?: DialogAction;
    canSubmit?: boolean;
    footerStart?: ReactNode;
    readOnly?: boolean;
    description?: string;
} = {}) {
    onOpenChange.mockClear();
    ({ unmount } = await renderInDocument(
        createElement(FormDialog, {
            open: true,
            onOpenChange,
            title: 'Rename',
            description,
            children: createElement(FormDialogForm, {
                onSubmit,
                canSubmit,
                submitLabel: 'Save',
                footerStart,
                readOnly,
                children: createElement(Input, { 'aria-label': 'Name', defaultValue: 'Notes' }),
            }),
        }),
    ));
}

const dialog = () => document.querySelector('[role="dialog"]');
const field = () => document.querySelector('[role="dialog"] input');
const footerButtons = () => [
    ...(dialog()?.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-footer"] button') ?? []),
];
const button = (label: string) => footerButtons().find((b) => b.textContent === label);

const enter = () =>
    act(async () => {
        const input = field();
        if (!input) throw new Error('no field');
        pressEnter(input);
    });

const click = (label: string) =>
    act(async () => {
        const target = button(label);
        if (!target) throw new Error(`no ${label} button`);
        target.click();
    });

// Cancelable, as a browser's is, so a dialog that leaves the Escape to an open preview can refuse it.
const pressEscape = () =>
    act(async () => {
        document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
    });

test('Enter in a field submits, and the dialog closes', async () => {
    const onSubmit = mock(() => {});
    await render({ onSubmit });
    await enter();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('Cancel closes without submitting', async () => {
    const onSubmit = mock(() => {});
    await render({ onSubmit });
    await click('Cancel');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('Escape closes it while no submit runs', async () => {
    await render();
    await pressEscape();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('with canSubmit off the submit button is disabled and Enter does nothing', async () => {
    const onSubmit = mock(() => {});
    await render({ onSubmit, canSubmit: false });
    expect(button('Save')?.disabled).toBe(true);
    await enter();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
});

test('a slow submit disables both buttons, keeps its label, and Escape waits for it', async () => {
    let finish = () => {};
    await render({ onSubmit: () => new Promise<void>((resolve) => (finish = resolve)) });
    await click('Save');
    expect(footerButtons().map((b) => [b.textContent, b.disabled])).toEqual([
        ['Cancel', true],
        ['Save', true],
    ]);
    await pressEscape();
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a submit that fails keeps the dialog open for another try', async () => {
    // A mutation hook toasts its failure before the dialog sees it.
    const failure = new Error('offline');
    onMutationError(failure);
    const onSubmit = mock(() => Promise.reject(failure));
    await render({ onSubmit });
    await click('Save');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(button('Save')?.disabled).toBe(false);
});

test('a submit that returns or resolves false keeps the dialog open, and the next one closes it', async () => {
    let result: ReturnType<DialogAction> = false;
    const onSubmit = mock(() => result);
    await render({ onSubmit });
    await enter();
    expect(onOpenChange).not.toHaveBeenCalled();
    result = Promise.resolve<false>(false);
    await enter();
    expect(onOpenChange).not.toHaveBeenCalled();
    result = Promise.resolve();
    await enter();
    expect(onSubmit).toHaveBeenCalledTimes(3);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a submit that returned false leaves Escape closing the dialog', async () => {
    await render({ onSubmit: () => false });
    await enter();
    await pressEscape();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a second Enter while the dialog animates out submits nothing', async () => {
    // Radix keeps a closing dialog mounted while its animation runs. happy-dom computes no animation from a style
    // sheet and never ends one, so the content reports a fade-out once it closes and stays.
    globalThis.getComputedStyle = (element, pseudo) => {
        const style = realGetComputedStyle(element, pseudo);
        if (!(element instanceof HTMLElement) || element.dataset.slot !== 'dialog-content') return style;
        return new Proxy(style, {
            get: (target, key) =>
                key === 'animationName'
                    ? element.dataset.state === 'closed'
                        ? 'fade-out'
                        : 'fade-in'
                    : Reflect.get(target, key),
        });
    };
    const onSubmit = mock(() => {});
    function Harness() {
        const [open, setOpen] = useState(true);
        return createElement(FormDialog, {
            open,
            onOpenChange: setOpen,
            title: 'Rename',
            children: createElement(FormDialogForm, {
                onSubmit,
                submitLabel: 'Save',
                children: createElement(Input, { 'aria-label': 'Name', defaultValue: 'Notes' }),
            }),
        });
    }
    ({ unmount } = await renderInDocument(createElement(Harness)));
    await enter();
    expect(dialog()?.getAttribute('data-state')).toBe('closed');
    await enter();
    expect(onSubmit).toHaveBeenCalledTimes(1);
});

test('the corner X is shown and closes the dialog', async () => {
    await render();
    const close = dialog()?.querySelector<HTMLButtonElement>(':scope > [data-slot="dialog-close"]');
    expect(close?.textContent).toBe('Close');
    await act(async () => close?.click());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('footerStart sits first in the footer, pushed to the left', async () => {
    await render({ footerStart: createElement('button', { type: 'button' }, 'Delete') });
    const start = dialog()?.querySelector('[data-slot="dialog-footer"]')?.firstElementChild;
    expect(start?.textContent).toBe('Delete');
    expect(start?.classList.contains('mr-auto')).toBe(true);
    expect(footerButtons().map((b) => b.textContent)).toEqual(['Delete', 'Cancel', 'Save']);
});

test('Enter in a field submits, not the footerStart button', async () => {
    const onSubmit = mock(() => {});
    const onDelete = mock(() => {});
    await render({ onSubmit, footerStart: createElement('button', { type: 'button', onClick: onDelete }, 'Delete') });
    await enter();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
});

test('readOnly shows only Close, and Enter submits nothing', async () => {
    const onSubmit = mock(() => {});
    await render({ onSubmit, readOnly: true });
    expect(footerButtons().map((b) => b.textContent)).toEqual(['Close']);
    await enter();
    expect(onSubmit).not.toHaveBeenCalled();
    await click('Close');
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a description shows under the title and a screen reader reads it, and without one it reads none', async () => {
    await render({ description: 'Give the file a new name.' });
    const describedBy = dialog()?.getAttribute('aria-describedby');
    const description = describedBy ? document.getElementById(describedBy) : null;
    expect(description?.textContent).toBe('Give the file a new name.');
    expect(description?.closest('[data-slot="dialog-header"]')).not.toBeNull();
    expect(description?.classList.contains('sr-only')).toBe(false);
    await unmount();
    await render();
    expect(dialog()?.hasAttribute('aria-describedby')).toBe(false);
});

test('abovePreview lifts the dialog over an open preview, and Escape there closes the dialog', async () => {
    onOpenChange.mockClear();
    const preview = { openPreview: () => {}, updatePreview: () => {}, closePreview: () => {}, isPreviewOpen: true };
    const renderOverPreview = async (abovePreview: boolean) => {
        ({ unmount } = await renderInDocument(
            createElement(
                PreviewContext.Provider,
                { value: preview },
                createElement(FormDialog, {
                    open: true,
                    onOpenChange,
                    title: 'Import',
                    abovePreview,
                    children: createElement(FormDialogForm, {
                        onSubmit: () => {},
                        submitLabel: 'Import',
                        children: null,
                    }),
                }),
            ),
        ));
    };
    // Under a preview the Escape is the preview's, so a dialog that is not flagged stays open.
    await renderOverPreview(false);
    expect(dialog()?.classList.contains(ABOVE_PREVIEW_Z)).toBe(false);
    await pressEscape();
    expect(onOpenChange).not.toHaveBeenCalled();
    await unmount();

    await renderOverPreview(true);
    expect(dialog()?.classList.contains(ABOVE_PREVIEW_Z)).toBe(true);
    await pressEscape();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a dialog opened from inside another form submits only itself', async () => {
    const onSubmit = mock(() => {});
    const outerSubmit = mock(() => {});
    ({ unmount } = await renderInDocument(
        createElement(
            'form',
            {
                onSubmit: (event: { preventDefault: () => void }) => {
                    event.preventDefault();
                    outerSubmit();
                },
            },
            createElement(FormDialog, {
                open: true,
                onOpenChange,
                title: 'Rename',
                children: createElement(FormDialogForm, {
                    onSubmit,
                    submitLabel: 'Save',
                    children: createElement(Input, { 'aria-label': 'Name', defaultValue: 'Notes' }),
                }),
            }),
        ),
    ));
    await enter();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(outerSubmit).not.toHaveBeenCalled();
});
