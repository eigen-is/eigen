// The card form tells its host whether it changed, so the host's Esc knows when to ask, and a value typed back to what
// it was counts as no change. It compares with what it opened with, so a value the host learns late, such as the
// card's assignee, is no change and Save leaves it alone. Its Description is a named field that shows its placeholder,
// and a missing title's message describes the Title field.
import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { CardForm } = await import('../../../components/cards/card-form');

const titleField = () => {
    const input = document.querySelector('input');
    if (!(input instanceof HTMLInputElement)) throw new Error('no Title field');
    return input;
};

// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
const typeTitle = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(titleField(), value);
        titleField().dispatchEvent(new Event('input', { bubbles: true }));
    });

test('the form reports a change, and none once the title is typed back', async () => {
    const onChangedChange = mock((_changed: boolean) => {});
    await renderInDocument(
        createElement(CardForm, {
            mode: 'edit',
            initialTitle: 'Audit card',
            initialDescription: 'Plain text',
            onSave: () => {},
            pending: false,
            onCancel: () => {},
            onChangedChange,
        }),
    );
    // The editor rewrites the plain description as html as it loads, which is no change.
    expect(onChangedChange.mock.calls.at(-1)?.[0]).toBe(false);
    await typeTitle('Audit card, checked');
    expect(onChangedChange.mock.calls.at(-1)?.[0]).toBe(true);
    await typeTitle('Audit card');
    expect(onChangedChange.mock.calls.at(-1)?.[0]).toBe(false);
});

test('a color picked counts as a change', async () => {
    const onChangedChange = mock((_changed: boolean) => {});
    await renderInDocument(
        createElement(CardForm, { onSave: () => {}, pending: false, onCancel: () => {}, onChangedChange }),
    );
    const swatches = document.querySelectorAll<HTMLElement>('button[style*="background-color"]');
    const other = [...swatches].at(-1);
    if (!other) throw new Error('no color swatch');
    await act(async () => other.click());
    expect(onChangedChange.mock.calls.at(-1)?.[0]).toBe(true);
});

test('Description is named by its label and shows its placeholder', async () => {
    await renderInDocument(
        createElement(CardForm, {
            onSave: () => {},
            pending: false,
            onCancel: () => {},
            onChangedChange: () => {},
            placeholderDescription: 'Add details',
        }),
    );
    const editor = document.querySelector('[contenteditable="true"]');
    const label = document.getElementById(editor?.getAttribute('aria-labelledby') ?? '');
    expect(label?.textContent).toBe('Description');
    expect(editor?.getAttribute('data-placeholder')).toBe('Add details');
});

test('an assignee the host learns after the edit opened is no change, and Save leaves it alone', async () => {
    const onChangedChange = mock((_changed: boolean) => {});
    const onSave = mock((..._args: unknown[]) => {});
    let learn = (_assignee: string) => {};
    function LateEntry() {
        const [assignee, setAssignee] = useState<string | null>(null);
        learn = setAssignee;
        return createElement(CardForm, {
            mode: 'edit',
            initialTitle: 'Audit card',
            initialAssignee: assignee,
            onSave,
            pending: false,
            onCancel: () => {},
            onChangedChange,
        });
    }
    await renderInDocument(createElement(LateEntry));
    await act(async () => learn('ada@example.org'));
    expect(onChangedChange.mock.calls.at(-1)?.[0]).toBe(false);
    await typeTitle('Audit card, checked');
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    await act(async () => save?.click());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[2]).toBeUndefined();
});

test('Save with no title says so under the field, and the message describes it', async () => {
    await renderInDocument(
        createElement(CardForm, { onSave: () => {}, pending: false, onCancel: () => {}, onChangedChange: () => {} }),
    );
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    await act(async () => save?.click());
    const message = document.querySelector('[data-slot="field-error"]');
    expect(message?.textContent).toBe('Add a title');
    expect(titleField().getAttribute('aria-describedby')).toBe(message?.id ?? 'no message');
});
