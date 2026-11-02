// A contact add row often sits inside a form, such as Calendar's New event or Edit calendar. Adding a person there,
// with Enter in the field or with the + button, adds that person and leaves the form unsubmitted. The + is named
// Add, for a screen reader.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { pressEnter } from '../../press-enter';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const realContacts = await import('@workspace/lib/contacts');
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
    useContactSuggestions: () => ({ suggestions: [], isLoading: false }),
}));

const { act, createElement } = await import('react');
const { ContactAddRow } = await import('../../../components/contacts/contact-add-row');

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
            createElement(ContactAddRow, { value: 'ada@example.org', onChange: () => {}, onSubmit: onAdd }),
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
