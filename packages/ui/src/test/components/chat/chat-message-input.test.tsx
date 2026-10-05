// A Radix dialog dismisses on Escape from a document capture listener, which runs before the textarea
// hears the key. Pinned here: Escape with the @-mention list open closes only the list, inside a dialog
// as well, and Escape with nothing open still closes the dialog.
import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

mock.module('@workspace/lib/auth', () => ({ useAuth: () => ({ user: null }), useIsGuest: () => false }));

const { act, createElement } = await import('react');
const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import('../../../components/dialog');
const { ChatMessageInput } = await import('../../../components/chat/chat-message-input');

const roomMembers = [{ email: 'ada@example.com', displayName: 'Ada' }];

async function mount() {
    const closed = { count: 0 };
    const { unmount } = await renderInDocument(
        createElement(
            Dialog,
            {
                open: true,
                onOpenChange: (open: boolean) => {
                    if (!open) closed.count += 1;
                },
            },
            createElement(
                DialogContent,
                null,
                createElement(DialogTitle, null, 'Card'),
                createElement(DialogDescription, null, 'Replies'),
                createElement(ChatMessageInput, { onSend: () => {}, roomMembers }),
            ),
        ),
    );
    const textarea = document.querySelector('textarea');
    if (!textarea) throw new Error('the input drew no textarea');

    const type = async (value: string) => {
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    const pressEscape = async () => {
        await act(async () => {
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
    };
    return { closed, textarea, type, pressEscape, cleanup: unmount };
}

test('Escape with the @-mention list open closes the list, not the dialog', async () => {
    const { closed, textarea, type, pressEscape, cleanup } = await mount();
    await type('hi @');
    expect(document.querySelectorAll('li')).toHaveLength(1);

    await pressEscape();
    expect(closed.count).toBe(0);
    expect(textarea.value).toBe('hi ');
    expect(document.querySelectorAll('li')).toHaveLength(0);

    await pressEscape();
    expect(closed.count).toBe(1);
    await cleanup();
});

test('Escape on an @-mention with no matches closes the dialog', async () => {
    const { closed, type, pressEscape, cleanup } = await mount();
    await type('hi @zed');
    await pressEscape();
    expect(closed.count).toBe(1);
    await cleanup();
});
