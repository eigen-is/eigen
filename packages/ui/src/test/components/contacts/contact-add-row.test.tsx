// A contact add row often sits inside a form, such as Calendar's New event or Edit calendar. Adding a person there,
// with Enter in the field or with the + button, adds that person and leaves the form unsubmitted. The + is named
// Add, for a screen reader. An address the row can't read, or a person the caller refuses, keeps the text and says
// why under the field, until the text changes.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { pressEnter } from '../../press-enter';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const realContacts = await import('@workspace/lib/contacts');
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
    useContacts: () => ({ data: [] }),
    useContactSuggestions: () => ({ suggestions: [], isLoading: false }),
}));

const { act, createElement } = await import('react');
const { ContactAddRow } = await import('../../../components/contacts/contact-add-row');
const { useContactInput } = await import('../../../components/contacts/use-contact-input');

let unmount = async () => {};
afterEach(() => unmount());

const onAdd = mock(() => {});
const onFormSubmit = mock((event: Event) => event.preventDefault());

async function render() {
    onAdd.mockClear();
    onFormSubmit.mockClear();
    ({ unmount } = await renderInDocument(
        createElement(
            'form',
            { onSubmit: (event: { nativeEvent: Event }) => onFormSubmit(event.nativeEvent) },
            createElement(ContactAddRow, {
                value: 'ada@example.org',
                onChange: () => {},
                onSubmit: onAdd,
                error: undefined,
            }),
            createElement('button', { type: 'submit' }, 'Save'),
        ),
    ));
}

test('Enter in the field adds the person and submits nothing', async () => {
    await render();
    const input = document.querySelector('input');
    if (!input) throw new Error('the row drew no field');
    await act(async () => pressEnter(input));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onFormSubmit).not.toHaveBeenCalled();
});

test('the + button is named Add, and adds the person and submits nothing', async () => {
    await render();
    const add = document.querySelector<HTMLButtonElement>('form button[aria-label="Add"]');
    if (!add) throw new Error('the row has no button named Add');
    await act(async () => add.click());
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onFormSubmit).not.toHaveBeenCalled();
});

// The row as every caller wires it, refusing the one address the caller names, as the guest list refuses the user's own.
function Wired({ refuse }: { refuse: string }) {
    const contactInput = useContactInput(({ email }) => (email === refuse ? 'You cannot invite yourself' : undefined));
    return createElement(ContactAddRow, {
        value: contactInput.value,
        onChange: contactInput.handleChange,
        onSubmit: contactInput.submit,
        error: contactInput.error,
    });
}

async function renderWired() {
    ({ unmount } = await renderInDocument(createElement(Wired, { refuse: 'me@example.org' })));
    const input = document.querySelector('input');
    if (!input) throw new Error('the row drew no field');
    return input;
}

const type = (input: HTMLInputElement, value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });

// The message under the field, and the field marked as wrong and pointing at it, or null for a field with no problem.
function problem(input: HTMLInputElement) {
    const message = document.querySelector('[data-slot="field-error"]');
    if (!message) return input.getAttribute('aria-invalid') === 'true' ? 'marked wrong with no message' : null;
    if (input.getAttribute('aria-invalid') !== 'true') return 'message on a field not marked wrong';
    if (input.getAttribute('aria-describedby') !== message.id) return 'field not described by its message';
    return message.textContent;
}

test('a fresh row shows no problem', async () => {
    expect(problem(await renderWired())).toBeNull();
});

test('Enter on an address the row cannot read keeps the text and says why under the field', async () => {
    const input = await renderWired();
    await type(input, 'ada@');
    await act(async () => pressEnter(input));
    expect(input.value).toBe('ada@');
    expect(problem(input)).toBe('Enter a valid email address');
});

test('the + on an address the caller refuses keeps the text and shows its reason, until the text changes', async () => {
    const input = await renderWired();
    await type(input, 'me@example.org');
    const add = document.querySelector<HTMLButtonElement>('button[aria-label="Add"]');
    await act(async () => add?.click());
    expect(input.value).toBe('me@example.org');
    expect(problem(input)).toBe('You cannot invite yourself');
    await type(input, 'ada@example.org');
    expect(problem(input)).toBeNull();
});

test('retyping a refused address brings no old reason back before it is added again', async () => {
    const input = await renderWired();
    await type(input, 'ada@');
    await act(async () => pressEnter(input));
    await type(input, 'ada@e');
    await type(input, 'ada@');
    expect(problem(input)).toBeNull();
});

test('a person taken clears the field and shows no problem', async () => {
    const input = await renderWired();
    await type(input, 'ada@');
    await act(async () => pressEnter(input));
    await type(input, 'ada@example.org');
    await act(async () => pressEnter(input));
    expect(input.value).toBe('');
    expect(problem(input)).toBeNull();
});
