// Editing a reply in place inside a card: Esc cancels only that edit, and the card stays open. A Radix dialog hears
// Esc on the document before the textarea does, so the field has to tell the dialog the key is its own.
import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { CardDialogFrame } = await import('../../../components/cards/card-dialog-frame');
const { InlineEdit } = await import('../../../components/chat/inline-edit');

test('Esc in a reply being edited inside a card cancels the edit and keeps the card open', async () => {
    const onOpenChange = mock((_open: boolean) => {});
    const onCancel = mock(() => {});
    await renderInDocument(
        createElement(CardDialogFrame, {
            open: true,
            onOpenChange,
            title: 'Card',
            children: createElement(InlineEdit, { initialContent: 'A reply', onSave: () => {}, onCancel }),
        }),
    );
    const textarea = document.querySelector('[role="dialog"] textarea');
    if (!textarea) throw new Error('no reply being edited');
    await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect([onCancel.mock.calls.length, onOpenChange.mock.calls.length]).toEqual([1, 0]);
});
