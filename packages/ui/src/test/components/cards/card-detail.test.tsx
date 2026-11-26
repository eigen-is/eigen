// CardDetail hands any host the parts of an opened card, with no dialog around it: the title, whether it is deleted,
// its actions, its body, and the edit form only while the host edits. The host's Edit action opens the form and the
// form's Cancel closes it, through the host's own editing state. With no card open it hands null, so a frame that
// stays, such as a column over its list, keeps its place.
import { afterAll, expect, mock, test } from 'bun:test';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { ReactNode } from 'react';
import type { CardDetailParts } from '../../../components/cards/card-detail';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const realAuth = await import('@workspace/lib/auth');
const realThread = { ...(await import('../../../components/comments/comment-thread')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));
// The thread's chat room fetches, so it shows only the card above it.
mock.module('../../../components/comments/comment-thread', () => ({
    CommentThread: ({ lead }: { lead: ReactNode }) => createElement('div', null, lead),
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('../../../components/comments/comment-thread', () => realThread);
});

const { CardDetail } = await import('../../../components/cards/card-detail');
const { PreviewProvider } = await import('../../../components/preview-provider');

const card: CommentCard = {
    id: 'card-1',
    title: 'Audit card',
    description: '<p>Check the roof</p>',
    color: '#fde68a',
    chatName: 'audit.eigenchat',
};

// The parts as the host last got them.
let parts: CardDetailParts | null | undefined;

// A host with no dialog: it lays the parts out in plain sections.
function Host({ deleted = false, open = true }: { deleted?: boolean; open?: boolean }) {
    const [editing, setEditing] = useState(false);
    return createElement(
        PreviewProvider,
        null,
        createElement(CardDetail, {
            card: open ? card : null,
            ownerId: 'owner-1',
            mountId: 'm1',
            pathId: 'board-1',
            deleted,
            isEditing: editing,
            onEditingChange: setEditing,
            onUpdate: () => {},
            children: (handed: CardDetailParts | null) => {
                parts = handed;
                if (!handed) return createElement('main', null, 'Frame');
                return createElement(
                    'main',
                    null,
                    createElement('section', { 'data-part': 'actions' }, handed.actions),
                    createElement('section', { 'data-part': 'body' }, handed.body),
                    handed.editForm &&
                        createElement(
                            'section',
                            { 'data-part': 'edit' },
                            handed.editForm({ pending: false, run: async () => undefined, onChangedChange: () => {} }),
                        ),
                );
            },
        }),
    );
}

const part = (name: string) => document.querySelector(`[data-part="${name}"]`);
const click = (label: string) =>
    act(async () => {
        const button = [...document.querySelectorAll('button')].find(
            (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label,
        );
        if (!button) throw new Error(`no ${label} button`);
        button.click();
    });

test('a card hands its title, actions and body, and no edit form until the host edits', async () => {
    const { unmount } = await renderInDocument(createElement(Host));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect([parts?.title, parts?.deleted, parts?.editForm]).toEqual(['Audit card', false, null]);
    expect(part('actions')?.querySelector('button[aria-label="Edit"]')).not.toBeNull();
    expect(part('body')?.textContent).toContain('Check the roof');
    expect(part('edit')).toBeNull();
    await unmount();
});

test("the Edit action brings the edit form and the form's Cancel takes it away", async () => {
    const { unmount } = await renderInDocument(createElement(Host));
    await click('Edit');
    expect(part('edit')?.querySelector('form')).not.toBeNull();
    await click('Cancel');
    expect([part('edit'), parts?.editForm]).toEqual([null, null]);
    await unmount();
});

test('a deleted card hands the deleted state, with nothing that acts', async () => {
    const { unmount } = await renderInDocument(createElement(Host, { deleted: true }));
    expect([parts?.title, parts?.deleted, parts?.editForm]).toEqual(['Audit card', true, null]);
    expect(part('body')?.textContent).toContain('This comment was deleted');
    expect(document.querySelectorAll('button').length).toBe(0);
    await unmount();
});

test('with no card open it hands null, and the frame still renders', async () => {
    const { unmount } = await renderInDocument(createElement(Host, { open: false }));
    expect(parts).toBeNull();
    expect(document.querySelector('main')?.textContent).toBe('Frame');
    await unmount();
});
