// The card form tells its host whether it changed, so the host's Esc knows when to ask, and a value typed back to what
// it was counts as no change. Its Description is a named field that shows its placeholder.
import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
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
    await renderInDocument(createElement(CardForm, { onSave: () => {}, onCancel: () => {}, onChangedChange }));
    const swatches = document.querySelectorAll<HTMLElement>('button[style*="background-color"]');
    const other = [...swatches].at(-1);
    if (!other) throw new Error('no color swatch');
    await act(async () => other.click());
    expect(onChangedChange.mock.calls.at(-1)?.[0]).toBe(true);
});

test('Description is named by its label and shows its placeholder', async () => {
    await renderInDocument(
        createElement(CardForm, { onSave: () => {}, onCancel: () => {}, placeholderDescription: 'Add details' }),
    );
    const editor = document.querySelector('[contenteditable="true"]');
    const label = document.getElementById(editor?.getAttribute('aria-labelledby') ?? '');
    expect(label?.textContent).toBe('Description');
    expect(editor?.getAttribute('data-placeholder')).toBe('Add details');
});
