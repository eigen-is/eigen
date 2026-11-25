// The form under every shell submits on Cmd or Ctrl+Enter from any field, a multi-line one and one that took the key
// for itself included, and on Enter from a radio or a checkbox. It saves what a field commits on that Enter. It acts
// only on keys from its own fields, keeps Cmd+Enter from a hotkey behind it, and never shows the browser's bubbles. Its
// fields learn that Save was pressed, and a refused submit focuses the first field marked invalid unless the form
// focuses its own errors.
import { afterEach, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import type { DialogAction } from '../../hooks/use-dialog-pending';
import { installHappyDom } from '../happy-dom';
import { pressKey } from '../press-key';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { createPortal } = await import('react-dom');
const { FormShell, useFormSubmitted } = await import('../../components/form-shell');
const { RadioGroup, RadioGroupItem } = await import('../../components/radio-group');
const { Checkbox } = await import('../../components/checkbox');

let unmount = async () => {};
afterEach(() => unmount());

async function render(children: ReactNode, { onSubmit = () => {}, focusesOwnErrors = false } = {}) {
    const submit = mock<DialogAction>(onSubmit);
    ({ unmount } = await renderInDocument(createElement(FormShell, { onSubmit: submit, focusesOwnErrors, children })));
    return submit;
}

const byLabel = (label: string) => {
    const found = document.querySelector(`[aria-label="${label}"]`);
    if (!found) throw new Error(`no ${label}`);
    return found;
};

// The shell submits on the task after the key, so the press waits for it.
const keydown = (target: Element, init: KeyboardEventInit) =>
    act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
        await nextTask();
    });
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Cmd+Enter and Ctrl+Enter submit from a multi-line field, and plain Enter there does not', async () => {
    const onSubmit = await render(createElement('textarea', { 'aria-label': 'Notes' }));
    await keydown(byLabel('Notes'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    await keydown(byLabel('Notes'), { key: 'Enter', metaKey: true });
    await keydown(byLabel('Notes'), { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
});

test('Cmd+Enter submits from a field that took the key for itself, and goes no further', async () => {
    const behind = mock((_event: KeyboardEvent) => {});
    document.addEventListener('keydown', behind);
    const onSubmit = await render(
        createElement('div', {
            'aria-label': 'Description',
            contentEditable: true,
            // As a rich-text field does, so its line-break shortcut doesn't run.
            onKeyDown: (event: { preventDefault: () => void }) => event.preventDefault(),
        }),
    );
    await keydown(byLabel('Description'), { key: 'Enter', metaKey: true });
    document.removeEventListener('keydown', behind);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(behind).not.toHaveBeenCalled();
});

// Sets its time into the form's state only on Enter, as the calendar's time field does.
function CommitOnEnterForm({ onSave }: { onSave: (time: string) => void }) {
    const [time, setTime] = useState('09:00');
    return createElement(FormShell, {
        onSubmit: () => onSave(time),
        children: createElement('input', {
            'aria-label': 'Start',
            defaultValue: time,
            onKeyDown: (event: { key: string; currentTarget: HTMLInputElement }) => {
                if (event.key === 'Enter') setTime(event.currentTarget.value);
            },
        }),
    });
}

test('Cmd+Enter saves what a field commits on that Enter', async () => {
    const onSave = mock((_time: string) => {});
    ({ unmount } = await renderInDocument(createElement(CommitOnEnterForm, { onSave })));
    const start = byLabel('Start');
    if (!(start instanceof HTMLInputElement)) throw new Error('Start is no input');
    start.value = '14:30';
    await keydown(start, { key: 'Enter', metaKey: true });
    expect(onSave.mock.calls).toEqual([['14:30']]);
});

test('Enter on a radio or a checkbox submits once', async () => {
    const onSubmit = await render([
        createElement(
            RadioGroup,
            { key: 'scope', defaultValue: 'this' },
            createElement(RadioGroupItem, { value: 'this', 'aria-label': 'This event' }),
            createElement(RadioGroupItem, { value: 'all', 'aria-label': 'All events' }),
        ),
        createElement(Checkbox, { key: 'notify', 'aria-label': 'Notify guests' }),
    ]);
    await act(async () => {
        pressKey(byLabel('This event'), 'Enter');
        await nextTask();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => {
        pressKey(byLabel('Notify guests'), 'Enter');
        await nextTask();
    });
    expect(onSubmit).toHaveBeenCalledTimes(2);
});

test('a key from a field portaled out of the form does not submit it', async () => {
    const onSubmit = await render(createPortal(createElement('textarea', { 'aria-label': 'Search' }), document.body));
    await keydown(byLabel('Search'), { key: 'Enter', metaKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
});

test('a required field left empty still submits, with no browser bubble', async () => {
    const onSubmit = await render([
        createElement('input', { key: 'name', 'aria-label': 'Name', required: true }),
        createElement('button', { key: 'save', type: 'submit' }, 'Save'),
    ]);
    expect(document.querySelector('form')?.noValidate).toBe(true);
    await keydown(byLabel('Name'), { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
});

function Title() {
    const submitted = useFormSubmitted();
    return createElement('input', { 'aria-label': 'Title', 'aria-invalid': submitted || undefined });
}

test('a field learns that Save was pressed, and not before', async () => {
    await render(createElement(Title));
    expect(byLabel('Title').hasAttribute('aria-invalid')).toBe(false);
    await keydown(byLabel('Title'), { key: 'Enter', metaKey: true });
    expect(byLabel('Title').getAttribute('aria-invalid')).toBe('true');
});

// Marks its second field invalid as its check refuses, as a form whose submit names a field does.
function CheckedForm({ focusesOwnErrors }: { focusesOwnErrors: boolean }) {
    const [error, setError] = useState(false);
    return createElement(FormShell, {
        focusesOwnErrors,
        onSubmit: async () => {
            setError(true);
            return false as const;
        },
        children: [
            createElement('input', { key: 'title', 'aria-label': 'Title' }),
            createElement('input', { key: 'end', 'aria-label': 'End', 'aria-invalid': error || undefined }),
        ],
    });
}

test('a refused submit focuses the field it marked invalid', async () => {
    ({ unmount } = await renderInDocument(createElement(CheckedForm, { focusesOwnErrors: false })));
    await keydown(byLabel('Title'), { key: 'Enter', metaKey: true });
    expect(document.activeElement).toBe(byLabel('End'));
});

test('a form that focuses its own errors keeps the focus where it put it', async () => {
    ({ unmount } = await renderInDocument(createElement(CheckedForm, { focusesOwnErrors: true })));
    await keydown(byLabel('Title'), { key: 'Enter', metaKey: true });
    expect(document.activeElement).not.toBe(byLabel('End'));
});

test('a field already marked invalid as the form opens takes no focus', async () => {
    await render(createElement('input', { 'aria-label': 'Title', 'aria-invalid': true }));
    expect(document.activeElement).not.toBe(byLabel('Title'));
});
