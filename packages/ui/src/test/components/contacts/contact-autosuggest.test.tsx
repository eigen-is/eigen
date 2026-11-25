// A Radix dialog dismisses on Escape from a document capture listener, which runs before the input hears
// the key. Pinned here: Escape with the suggestion list open closes only the list, and the next Escape closes
// the dialog. Cmd+Enter in a form picks the row, and the form saves with that person.
import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));
const ada = { kind: 'personal', id: 'ada@example.com', displayName: 'Ada', email: 'ada@example.com' };
const realContacts = await import('@workspace/lib/contacts');
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
    useContactSuggestions: (query: string) => ({ suggestions: query ? [ada] : [], isLoading: false }),
}));

const { act, createElement, useState } = await import('react');
const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import('../../../components/dialog');
const { ContactAutosuggest } = await import('../../../components/contacts/contact-autosuggest');
const { FormShell } = await import('../../../components/form-shell');

test('Escape with the suggestion list open closes the list, not the dialog', async () => {
    let closed = 0;
    const { unmount } = await renderInDocument(
        createElement(
            Dialog,
            {
                open: true,
                onOpenChange: (open: boolean) => {
                    if (!open) closed += 1;
                },
            },
            createElement(
                DialogContent,
                null,
                createElement(DialogTitle, null, 'Share'),
                createElement(DialogDescription, null, 'Add people'),
                createElement(ContactAutosuggest, {}),
            ),
        ),
    );
    const input = document.querySelector('input');
    if (!input) throw new Error('the autosuggest drew no input');
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'ad');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelectorAll('li')).toHaveLength(1);

    const pressEscape = () =>
        act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
    await pressEscape();
    expect(closed).toBe(0);
    expect(document.querySelectorAll('li')).toHaveLength(0);

    await pressEscape();
    expect(closed).toBe(1);
    await unmount();
});

// An add-people form whose list of people is the field's value, as a share dialog's is.
function AddPeople({ onSave }: { onSave: (people: string) => void }) {
    const [people, setPeople] = useState('');
    return createElement(FormShell, {
        onSubmit: () => onSave(people),
        children: createElement(ContactAutosuggest, { value: people, onChange: setPeople }),
    });
}

test('Cmd+Enter with the list open picks the row, and the form saves with that person', async () => {
    const onSave = mock((_people: string) => {});
    const { unmount } = await renderInDocument(createElement(AddPeople, { onSave }));
    const input = document.querySelector('input');
    if (!input) throw new Error('the autosuggest drew no input');
    await act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'ad');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelectorAll('li')).toHaveLength(1);
    await act(async () => {
        input.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onSave.mock.calls).toEqual([['Ada <ada@example.com>']]);
    await unmount();
});
