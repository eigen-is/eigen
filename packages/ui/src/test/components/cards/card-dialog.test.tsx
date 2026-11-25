// A card's edit keeps the card contract: Esc goes back to the card's view as Cancel does, asking "Discard changes?"
// first once something changed, and only that edit ends, not the card. The corner X and a click outside close the card,
// asking the same question first once something changed. Every close waits while a save runs. While editing, no empty
// bar sits above the form. Leaving the edit, by Cancel, Discard or Save, puts the focus on the card's Edit action.
import { afterAll, expect, mock, test } from 'bun:test';
import type { CardFormPatch, CommentCard } from '@workspace/lib/types/comments';
import { expectFormContract, type } from '../../form-contract';
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
const update = mock(async (_patch: CardFormPatch) => {});

// The card's open state, as its host last set it.
let cardOpen = true;

function EditCard() {
    const [open, setOpen] = useState(true);
    cardOpen = open;
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

test("a card's edit keeps the card contract", async () => {
    await expectFormContract({
        kind: 'card',
        render: () => createElement(EditCard),
        submitLabel: 'Save',
        firstField: 'Title',
        onSubmit: update,
        makeChanged: () => type('Title', 'Audit card, checked'),
        makeInvalid: () => type('Title', ''),
        invalidField: 'Title',
        modEnterFields: ['Description'],
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

const buttonNamed = (label: string) => {
    const found = [...document.querySelectorAll('button')]
        .filter((b) => (b.getAttribute('aria-label') ?? b.lastChild?.textContent?.trim()) === label)
        .at(-1);
    if (!found) throw new Error(`no ${label} button`);
    return found;
};
const click = (label: string) => act(async () => buttonNamed(label).click());
const asking = () =>
    [...document.querySelectorAll('[role="dialog"] h2')].some((h) => h.textContent === 'Discard changes?');
const editing = () => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Save');
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

// The whole press on the card's overlay, since Radix waits for the click before it closes. A dialog that rendered again
// after a question over it closed listens again only from the next tick.
async function clickOutside() {
    await tick();
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    if (!overlay) throw new Error('no card is open');
    await act(async () => {
        overlay.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        overlay.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    await tick();
}

const CLOSES = [
    ['the X', () => click('Close')],
    ['a click outside', clickOutside],
] as const;

for (const [way, close] of CLOSES) {
    test(`${way} closes an unchanged card's edit at once`, async () => {
        await renderInDocument(createElement(EditCard));
        await close();
        expect([asking(), cardOpen]).toEqual([false, false]);
    });

    test(`${way} on a changed edit asks first, and Discard closes the card`, async () => {
        update.mockClear();
        await renderInDocument(createElement(EditCard));
        await type('Title', 'Audit card, checked');
        await close();
        expect([asking(), cardOpen, editing()]).toEqual([true, true, true]);
        await click('Keep editing');
        expect([asking(), cardOpen, editing(), titleField().value]).toEqual([false, true, true, 'Audit card, checked']);
        await close();
        expect(asking()).toBe(true);
        await click('Discard');
        expect([asking(), cardOpen]).toEqual([false, false]);
        expect(update).not.toHaveBeenCalled();
    });
}

const focusedLabel = () => document.activeElement?.getAttribute('aria-label');
const pressEscape = () =>
    act(async () => {
        const target = document.activeElement ?? document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

test("leaving the edit by Cancel, Discard or Save focuses the card's Edit action", async () => {
    const leaves: [string, () => Promise<void>][] = [
        ['Cancel', () => click('Cancel')],
        [
            'Discard',
            async () => {
                await type('Title', 'Audit card, checked');
                await pressEscape();
                await click('Discard');
            },
        ],
        ['Save', () => click('Save')],
    ];
    for (const [way, leave] of leaves) {
        const { unmount } = await renderInDocument(createElement(EditCard));
        await leave();
        expect([way, editing(), focusedLabel()]).toEqual([way, false, 'Edit']);
        await unmount();
    }
});
