// An open card edits in place. The title's pencil turns it into a field: Enter saves, Esc and the close button cancel
// without closing the dialog, and an unchanged title writes nothing, even after a collaborator renamed the card while
// the field was open. The resolve button applies at once.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard, CommentCardPatch } from '@workspace/lib/types/comments';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));
afterAll(() => mock.module('@workspace/lib/auth', () => realAuth));

const { act, createElement, useState } = await import('react');
const { CardDialog } = await import('../../../components/cards/card-dialog');
const { PreviewProvider } = await import('../../../components/preview-provider');

const card: CommentCard = {
    id: 'card-1',
    title: 'Print wristbands',
    description: '<p>Two colors</p>',
    chatName: 'thread-1.eigenchat',
};
const entry: CommentEntry = {
    chatName: 'thread-1.eigenchat',
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    lastAuthorEmail: null,
    lastActivityAt: null,
    messageCount: 0,
    createdAt: new Date(0),
    assignee: null,
    title: 'Print wristbands',
};

let unmount = async () => {};
afterEach(() => unmount());

let updates: [string, CommentCardPatch][] = [];
let resolves: [string, string, string | undefined][] = [];
let closes = 0;
beforeEach(() => {
    updates = [];
    resolves = [];
    closes = 0;
});

// A collaborator's rename, as the lifecycle hands the dialog the card again.
let rename: (title: string) => void = () => {};

function Harness() {
    const [title, setTitle] = useState(card.title);
    rename = setTitle;
    return createElement(
        PreviewProvider,
        null,
        createElement(CardDialog, {
            open: true,
            onOpenChange: () => {
                closes += 1;
            },
            card: { ...card, title },
            entry,
            ownerId: 'owner-1',
            mountId: 'm1',
            pathId: 'board-1',
            deleted: false,
            threadPlacement: 'beside',
            onUpdate: (cardId: string, patch: CommentCardPatch) => updates.push([cardId, patch]),
            onResolve: (chatName: string, next: string, title?: string) => resolves.push([chatName, next, title]),
        }),
    );
}

async function renderDialog() {
    ({ unmount } = await renderInDocument(createElement(Harness)));
}

const button = (name: string) => {
    const found = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
    );
    if (!found) throw new Error(`no ${name} button`);
    return found;
};
const titleField = () => document.querySelector<HTMLInputElement>('input[aria-label="Title"]');

async function editTitle(value: string) {
    await act(async () => button('Edit title').click());
    const field = titleField();
    if (!field) throw new Error('no title field');
    field.value = value;
    return field;
}
const press = (target: Element, key: string) =>
    act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });

test('Enter saves the new title and closes the field', async () => {
    await renderDialog();
    const field = await editTitle('  Print wristbands and tickets ');
    await press(field, 'Enter');
    expect(updates).toEqual([['card-1', { title: 'Print wristbands and tickets' }]]);
    expect(titleField()).toBeNull();
});

test('an unchanged or emptied title writes nothing', async () => {
    await renderDialog();
    await press(await editTitle('Print wristbands'), 'Enter');
    await press(await editTitle('   '), 'Enter');
    expect(updates).toEqual([]);
});

test('an untouched field writes nothing when a collaborator renamed the card meanwhile', async () => {
    await renderDialog();
    const field = await editTitle(card.title);
    await act(async () => rename('Print tickets'));
    await press(field, 'Enter');
    expect(updates).toEqual([]);
});

test('Esc cancels the edit and leaves the dialog open', async () => {
    await renderDialog();
    const field = await editTitle('Something else');
    await press(field, 'Escape');
    expect(titleField()).toBeNull();
    expect(updates).toEqual([]);
    expect(closes).toBe(0);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});

test('while a field is open the close button cancels it, and only then closes the dialog', async () => {
    await renderDialog();
    await editTitle('Something else');
    await act(async () => button('Cancel').click());
    expect(titleField()).toBeNull();
    expect(updates).toEqual([]);
    expect(closes).toBe(0);

    await act(async () => button('Close').click());
    expect(closes).toBe(1);
});

test('Resolve applies at once, with the title for the activity row', async () => {
    await renderDialog();
    await act(async () => button('Resolve').click());
    expect(resolves).toEqual([['thread-1.eigenchat', 'resolved', 'Print wristbands']]);
});

test("the description opens from its pencil, and its cancel button in the pencil's place writes nothing", async () => {
    await renderDialog();
    await act(async () => button('Edit description').click());
    expect(document.querySelector('[contenteditable="true"]')).not.toBeNull();
    const cancels = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Cancel"]')];
    await act(async () => cancels[cancels.length - 1]?.click());
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    expect(updates).toEqual([]);
    expect(closes).toBe(0);
});

test('the thread sits under All, Comments and Activity, and Activity has nothing yet', async () => {
    await renderDialog();
    const tab = (name: string) => {
        const found = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent === name);
        if (!found) throw new Error(`no ${name} tab`);
        return found;
    };
    // Radix tabs switch on the press, not the click.
    const pick = (name: string) =>
        act(async () => {
            tab(name).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        });
    expect(tab('All').getAttribute('aria-selected')).toBe('true');
    await pick('Activity');
    expect(document.body.textContent).toContain('No activity yet');
    await pick('Comments');
    expect(document.body.textContent).not.toContain('No activity yet');
});
