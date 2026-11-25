// CardDetail hands any host the parts of an opened card, with no dialog around it: the title, whether it is deleted,
// its actions, its body, and the edit form only while the host edits. The host's Edit action opens the form and the
// form's Cancel closes it, through the host's own editing state.
import { afterAll, expect, mock, test } from 'bun:test';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { CardDetailParts } from '../../../components/cards/card-detail';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));
afterAll(() => mock.module('@workspace/lib/auth', () => realAuth));

const { act, createElement, useState } = await import('react');
const { CardDetail } = await import('../../../components/cards/card-detail');
const { PreviewProvider } = await import('../../../components/preview-provider');

// No thread, so the body is the card and its line.
const card: CommentCard = { id: 'card-1', title: 'Audit card', description: '<p>Check the roof</p>', color: '#fde68a' };

// The parts as the host last got them.
let parts: CardDetailParts | undefined;

// A host with no dialog: it lays the parts out in plain sections.
function Host({ deleted = false }: { deleted?: boolean }) {
    const [editing, setEditing] = useState(false);
    return createElement(
        PreviewProvider,
        null,
        createElement(CardDetail, {
            card,
            ownerId: 'owner-1',
            mountId: 'm1',
            pathId: 'board-1',
            deleted,
            isEditing: editing,
            onEditingChange: setEditing,
            onUpdate: () => {},
            children: (handed: CardDetailParts) => {
                parts = handed;
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
