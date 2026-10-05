// A Radix dialog dismisses on Escape from a document capture listener, which runs before the input hears
// the key. Pinned here: Escape with the suggestion list open closes only the list, and the next Escape closes
// the dialog.
import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

mock.module('@workspace/lib/auth', () => ({ useAuth: () => ({ user: null }), useIsGuest: () => false }));
const ada = { kind: 'personal', id: 'ada@example.com', displayName: 'Ada', email: 'ada@example.com' };
const realContacts = await import('@workspace/lib/contacts');
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
    useContactSuggestions: (query: string) => ({ suggestions: query ? [ada] : [], isLoading: false }),
}));

const { act, createElement } = await import('react');
const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import('../../../components/dialog');
const { ContactAutosuggest } = await import('../../../components/contacts/contact-autosuggest');

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
