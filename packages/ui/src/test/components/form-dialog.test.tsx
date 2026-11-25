// A form dialog submits on Enter as on its submit button, and only when the caller says the fields are valid. While a
// submit runs, its buttons and every way to close it wait. It closes once the submit succeeds and stays open when it
// fails or returns false, for another try. A dialog that is closing takes no second submit, and a dialog opened from
// inside another form never submits that form. A changed form asks before Esc drops it, a dialog stacked on another
// asks for itself only, and the focus goes back to what opened the dialog it discarded.
import { afterEach, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import type { DialogAction } from '../../hooks/use-dialog-pending';
import { holdClosingDialogs } from '../closing-dialog';
import { installHappyDom } from '../happy-dom';
import { pressEnter } from '../press-enter';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');
const { Button } = await import('../../components/button');
const { FormDialog, FormDialogForm } = await import('../../components/form-dialog');
const { Input } = await import('../../components/input');
const { RadioGroup, RadioGroupItem } = await import('../../components/radio-group');

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
    onOpenAutoFocus,
    fields = createElement(Input, { 'aria-label': 'Name', defaultValue: 'Notes' }),
}: {
    onOpenAutoFocus?: (event: Event) => void;
    fields?: ReactNode;
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
            onOpenAutoFocus,
            children: createElement(FormDialogForm, {
                onSubmit,
                canSubmit,
                submitLabel: 'Save',
                footerStart,
                readOnly,
                children: fields,
            }),
        }),
    ));
}

const dialog = () => document.querySelector('[role="dialog"]');
const field = () => document.querySelector('[role="dialog"] input');
const footerButtons = () => [
    ...(dialog()?.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-footer"] button') ?? []),
];
// A pending button's spinner comes before its label.
const label = (b: HTMLButtonElement) => b.lastChild?.textContent;
const button = (name: string) => footerButtons().find((b) => label(b) === name);

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

// Cancelable, as a browser's is, so a dialog that waits for a running submit can refuse it.
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

test('a slow submit keeps its label beside a spinner, ignores another click, and Cancel and Escape wait for it', async () => {
    let finish = () => {};
    const onSubmit = mock(() => new Promise<void>((resolve) => (finish = resolve)));
    await render({ onSubmit });
    button('Save')?.focus();
    await click('Save');
    expect(footerButtons().map((b) => [label(b), b.disabled, b.getAttribute('aria-busy')])).toEqual([
        ['Cancel', true, null],
        ['Save', false, 'true'],
    ]);
    expect(document.activeElement).toBe(button('Save') ?? null);
    await click('Save');
    expect(onSubmit).toHaveBeenCalledTimes(1);
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

test('footerStart sits first in the footer, and Cancel and Save wrap together at the right', async () => {
    await render({ footerStart: createElement('button', { type: 'button' }, 'Delete') });
    const footer = dialog()?.querySelector('[data-slot="dialog-footer"]');
    expect(footer?.firstElementChild?.textContent).toBe('Delete');
    expect(footer?.lastElementChild?.textContent).toBe('CancelSave');
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

const byLabel = (name: string) => document.querySelector(`[aria-label="${name}"]`);
const selected = (name: string) => {
    const input = byLabel(name);
    return input instanceof HTMLInputElement
        ? input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)
        : '';
};

test('it opens on the first text field, not a swatch before it, and selects a lone name', async () => {
    await render({
        fields: [
            createElement('button', { key: 'colour', type: 'button', 'aria-label': 'Colour' }),
            createElement(Input, { key: 'name', 'aria-label': 'Name', defaultValue: 'Notes' }),
        ],
    });
    expect(document.activeElement).toBe(byLabel('Name'));
    expect(selected('Name')).toBe('Notes');
});

test('with several text fields it focuses the first and selects nothing', async () => {
    await render({
        fields: [
            createElement(Input, { key: 'title', 'aria-label': 'Title', defaultValue: 'Standup' }),
            createElement(Input, { key: 'place', 'aria-label': 'Location', defaultValue: 'Utrecht' }),
        ],
    });
    expect(document.activeElement).toBe(byLabel('Title'));
    expect(selected('Title')).toBe('');
});

test('with no text field it focuses the first control, the checked radio of a group', async () => {
    await render({
        fields: createElement(
            RadioGroup,
            { defaultValue: 'all' },
            createElement(RadioGroupItem, { value: 'this', 'aria-label': 'This event' }),
            createElement(RadioGroupItem, { value: 'all', 'aria-label': 'All events' }),
        ),
    });
    expect(document.activeElement).toBe(byLabel('All events'));
});

test("a caller's own open focus and a field's autoFocus win", async () => {
    await render({
        onOpenAutoFocus: (event) => {
            event.preventDefault();
            button('Cancel')?.focus();
        },
    });
    expect(document.activeElement).toBe(button('Cancel') ?? null);
    await unmount();
    await render({
        fields: [
            createElement(Input, { key: 'title', 'aria-label': 'Title' }),
            createElement(Input, { key: 'place', 'aria-label': 'Location', autoFocus: true }),
        ],
    });
    expect(document.activeElement).toBe(byLabel('Location'));
});

test('Cmd+Enter submits from a multi-line field', async () => {
    const onSubmit = mock(() => {});
    await render({ onSubmit, fields: createElement('textarea', { 'aria-label': 'Notes' }) });
    await act(async () => {
        byLabel('Notes')?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
        );
        // The shell submits on the next task.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
});

// Says why under its field and refuses, as a form whose check names a field does.
function CheckedName() {
    const [error, setError] = useState('');
    return createElement(FormDialogForm, {
        submitLabel: 'Save',
        onSubmit: () => {
            setError('Add a name');
            return false as const;
        },
        children: [
            createElement(Input, { key: 'title', 'aria-label': 'Title' }),
            createElement(Input, { key: 'name', 'aria-label': 'Name', 'aria-invalid': !!error || undefined }),
            error && createElement('p', { key: 'error' }, error),
        ],
    });
}

test('a refused submit keeps the dialog open and focuses the field it marked', async () => {
    onOpenChange.mockClear();
    ({ unmount } = await renderInDocument(
        createElement(FormDialog, { open: true, onOpenChange, title: 'Rename', children: createElement(CheckedName) }),
    ));
    await click('Save');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(byLabel('Name'));
});

// A Move dialog with a New folder dialog it opens over itself, both holding a change, as a location picker does.
function Stacked({ onMove }: { onMove: () => void }) {
    const [moving, setMoving] = useState(true);
    const [naming, setNaming] = useState(false);
    return createElement(FormDialog, {
        open: moving,
        onOpenChange: setMoving,
        title: 'Move',
        children: createElement(FormDialogForm, {
            changed: true,
            submitLabel: 'Move',
            onSubmit: onMove,
            children: [
                createElement(Input, { key: 'to', 'aria-label': 'Destination', defaultValue: 'Plans' }),
                createElement(Button, { key: 'new', onClick: () => setNaming(true) }, 'New folder'),
                createElement(FormDialog, {
                    key: 'naming',
                    open: naming,
                    onOpenChange: setNaming,
                    title: 'New folder',
                    children: createElement(FormDialogForm, {
                        changed: true,
                        submitLabel: 'Create',
                        onSubmit: () => {},
                        children: createElement(Input, { 'aria-label': 'Folder name', defaultValue: 'Q3' }),
                    }),
                }),
            ],
        }),
    });
}

// Radix hands the focus back on the task after a dialog closes.
const focusReturned = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const titles = () => [...document.querySelectorAll('[role="dialog"] h2')].map((title) => title.textContent);
const anyButton = (name: string) => [...document.querySelectorAll('button')].find((b) => label(b) === name);
const press = (name: string) =>
    act(async () => {
        const target = anyButton(name);
        if (!target) throw new Error(`no ${name} button`);
        target.focus();
        target.click();
    });

test('a changed dialog over another asks for itself only, Esc on the question keeps editing, and Discard closes it alone', async () => {
    const onMove = mock(() => {});
    ({ unmount } = await renderInDocument(createElement(Stacked, { onMove })));
    await press('New folder');
    expect(titles()).toEqual(['Move', 'New folder']);
    await pressEscape();
    expect(titles()).toEqual(['Move', 'New folder', 'Discard changes?']);
    await pressEscape();
    await focusReturned();
    expect(titles()).toEqual(['Move', 'New folder']);
    expect(document.activeElement).toBe(byLabel('Folder name'));
    await pressEscape();
    await press('Discard');
    await focusReturned();
    expect(titles()).toEqual(['Move']);
    expect(document.activeElement).toBe(anyButton('New folder') ?? null);
    expect(onMove).not.toHaveBeenCalled();
});

test('a form that says nothing changed closes at once, and a read-only one never asks', async () => {
    await render();
    await pressEscape();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    await unmount();
    onOpenChange.mockClear();
    ({ unmount } = await renderInDocument(
        createElement(FormDialog, {
            open: true,
            onOpenChange,
            title: 'Rename',
            children: createElement(FormDialogForm, {
                changed: true,
                readOnly: true,
                onSubmit: () => {},
                submitLabel: 'Save',
                children: createElement(Input, { 'aria-label': 'Name', defaultValue: 'Notes' }),
            }),
        }),
    ));
    await pressEscape();
    expect(titles()).not.toContain('Discard changes?');
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('after Discard the focus goes back to what opened the discarded dialog, whichever ends its fade-out first', async () => {
    for (const first of ['Discard changes?', 'New folder']) {
        const release = holdClosingDialogs();
        ({ unmount } = await renderInDocument(createElement(Stacked, { onMove: () => {} })));
        await press('New folder');
        await pressEscape();
        await press('Discard');
        for (const title of [first, ...['Discard changes?', 'New folder'].filter((other) => other !== first)]) {
            const content = [...document.querySelectorAll('[role="dialog"]')].find(
                (dialog) => dialog.querySelector('h2')?.textContent === title,
            );
            if (content?.getAttribute('data-state') !== 'closed') throw new Error(`${title} is not fading out`);
            await act(async () => {
                content.dispatchEvent(new AnimationEvent('animationend', { animationName: 'fade-out' }));
            });
            await focusReturned();
        }
        expect(titles()).toEqual(['Move']);
        expect(document.activeElement).toBe(anyButton('New folder') ?? null);
        release();
        await unmount();
    }
});

test('a changed form that another view replaces leaves the dialog closing at once', async () => {
    let replace = () => {};
    function Harness() {
        const [loading, setLoading] = useState(false);
        replace = () => setLoading(true);
        return createElement(FormDialog, {
            open: true,
            onOpenChange,
            title: 'Rename',
            children: loading
                ? 'Loading'
                : createElement(FormDialogForm, {
                      changed: true,
                      onSubmit: () => {},
                      submitLabel: 'Save',
                      children: createElement(Input, { 'aria-label': 'Name', defaultValue: 'Notes' }),
                  }),
        });
    }
    onOpenChange.mockClear();
    ({ unmount } = await renderInDocument(createElement(Harness)));
    await act(async () => replace());
    await pressEscape();
    expect(titles()).toEqual(['Rename']);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});
