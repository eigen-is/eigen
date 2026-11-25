// A card's edit keeps the card contract: Esc goes back to the card's view as Cancel does, asking "Discard changes?"
// first once something changed, and only that edit ends, not the card. While editing, no empty bar sits above the form.
import { afterAll, expect, mock, test } from 'bun:test';
import type { CardFormPatch, CommentCard } from '@workspace/lib/types/comments';
import { expectFormContract } from '../../form-contract';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));
afterAll(() => mock.module('@workspace/lib/auth', () => realAuth));

const { act, createElement, useState } = await import('react');
const { CardDialog } = await import('../../../components/cards/card-dialog');
const { PreviewProvider } = await import('../../../components/preview-provider');

// No thread, so the view is the card and its line.
const card: CommentCard = { id: 'card-1', title: 'Audit card', description: '', color: '#fde68a' };
const update = mock((_patch: CardFormPatch) => {});

function EditCard() {
    const [open, setOpen] = useState(true);
    const [editing, setEditing] = useState(true);
    return createElement(
        PreviewProvider,
        null,
        createElement(CardDialog, {
            open,
            onOpenChange: setOpen,
            card,
            ownerId: 'owner-1',
            mountId: 'm1',
            pathId: 'board-1',
            deleted: false,
            isEditing: editing,
            onEditingChange: setEditing,
            onUpdate: update,
        }),
    );
}

const titleField = () => {
    const input = document.querySelector('[role="dialog"] input');
    if (!(input instanceof HTMLInputElement)) throw new Error('no Title field');
    return input;
};

// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
const typeTitle = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(titleField(), value);
        titleField().dispatchEvent(new Event('input', { bubbles: true }));
    });

test("a card's edit keeps the card contract", async () => {
    await expectFormContract({
        kind: 'card',
        render: () => createElement(EditCard),
        submitLabel: 'Save',
        firstField: 'Title',
        onSubmit: update,
        makeChanged: () => typeTitle('Audit card, checked'),
        makeInvalid: () => typeTitle(''),
        invalidField: 'Title',
        modEnterFields: ['Description'],
        except: {
            pending: 'a card writes to its Y.Doc at once; only an upload leaves Save pending, as Add card shows',
        },
    });
});

test('an edit with nothing changed hands on an empty patch', async () => {
    update.mockClear();
    await renderInDocument(createElement(EditCard));
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    await act(async () => save?.click());
    expect(update).toHaveBeenCalledWith({});
});

test("while editing, the dialog's own X is its only close, with no bar above the form", async () => {
    await renderInDocument(createElement(EditCard));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
    expect(dialog?.querySelector('button[aria-label="Close"]')).toBeNull();
});
