// A form dialog submits on Enter as on its submit button, and only when the caller says the fields are valid. While a
// submit runs, its buttons and every way to close it wait. It closes once the submit succeeds and stays open when it
// fails, for another try.
import { afterEach, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { installHappyDom } from '../happy-dom';
import { pressEnter } from '../press-enter';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { FormDialog, FormDialogForm } = await import('../../components/form-dialog');
const { Input } = await import('../../components/input');

let unmount = async () => {};
afterEach(() => unmount());

const onOpenChange = mock((_open: boolean) => {});

async function render({
    onSubmit = () => {},
    canSubmit,
    footerStart,
    readOnly,
    description,
}: {
    onSubmit?: () => void | Promise<void>;
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

const pressEscape = () =>
    act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
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
    const onSubmit = mock(() => Promise.reject(new Error('offline')));
    await render({ onSubmit });
    await click('Save');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(button('Save')?.disabled).toBe(false);
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

test('readOnly shows only Close, and Enter submits nothing', async () => {
    const onSubmit = mock(() => {});
    await render({ onSubmit, readOnly: true });
    expect(footerButtons().map((b) => b.textContent)).toEqual(['Close']);
    await enter();
    expect(onSubmit).not.toHaveBeenCalled();
    await click('Close');
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a description is what a screen reader reads for the dialog, and without one it reads none', async () => {
    await render({ description: 'Give the file a new name.' });
    const describedBy = dialog()?.getAttribute('aria-describedby');
    expect(describedBy ? document.getElementById(describedBy)?.textContent : null).toBe('Give the file a new name.');
    await unmount();
    await render();
    expect(dialog()?.hasAttribute('aria-describedby')).toBe(false);
});
