// An editor's Activity panel opens what a row names: a card row by its card id, and a comment row by its chat name.
// The host's lifecycle decides whether that comment opens live or as deleted, so the panel never looks a card up.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { FileEvent } from '@workspace/lib/types/file-history';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const row = {
    pathId: 'path-1',
    pathName: 'Plan',
    pathType: 'file',
    actorUserId: 'u2',
    actorEmail: 'ann@example.com',
    createdAt: new Date('2026-11-01T10:00:00Z'),
} as const;
const events: FileEvent[] = [
    { ...row, id: 'e1', eventType: 'commented', details: { preview: 'Looks good', chatName: 'live.eigenchat' } },
    { ...row, id: 'e2', eventType: 'sticky-added', details: { card: 'Ship it', toColumn: 'Done', cardId: 'card-2' } },
];

const realDrive = { ...(await import('@workspace/lib/drive')) };
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useFileHistory: () => ({ data: events, isPending: false }),
}));
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: { id: 'u1' } }) }));
afterAll(() => {
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { act, createElement } = await import('react');
const { ActivityPanel } = await import('../../../components/comments/activity-panel');

let unmount = async () => {};
afterEach(() => unmount());

test('a comment row opens its chat name and a card row its card id', async () => {
    const onOpenCard = mock((_cardId: string) => {});
    const onOpenChat = mock((_chatName: string) => {});
    ({ unmount } = await renderInDocument(
        createElement(ActivityPanel, {
            path: drivePath({ name: 'Plan', mimeType: 'application/eigendoc' }),
            onOpenCard,
            onOpenChat,
        }),
    ));
    const rows = [...document.querySelectorAll('[role="button"]')];
    expect(rows.length).toBe(2);

    await act(async () => rows[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onOpenChat.mock.calls).toEqual([['live.eigenchat']]);
    expect(onOpenCard).not.toHaveBeenCalled();

    await act(async () => rows[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onOpenCard.mock.calls).toEqual([['card-2']]);
});
