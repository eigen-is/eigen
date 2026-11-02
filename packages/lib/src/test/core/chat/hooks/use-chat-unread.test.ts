import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { notificationKeys } from '../../../../core/notification/hooks/keys';
import { chatActivityTag, chatMentionTag, commentAssignedTag } from '../../../../core/notification/tags';
import type { Notification } from '../../../../types/notification';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

installHappyDom();

const { useUnreadCommentChatNames } = await import('../../../../core/chat/hooks/use-chat-unread');

const USER = 'user-1';
const BOARD = { ownerId: USER, mountId: 'm1', pathId: 'board-1' };

function row(type: string, tag: string, read = false): Notification {
    return {
        id: tag,
        type,
        actorEmail: 'bob@example.com',
        title: 't',
        body: null,
        tag,
        read,
        createdAt: new Date(),
        details: null,
    };
}

async function unreadNamesFor(rows: Notification[], containerPathId = BOARD.pathId) {
    const queryClient = new QueryClient();
    queryClient.setQueryData(notificationKeys.list(USER), rows);
    const { latest, unmount } = await renderHook(() => useUnreadCommentChatNames(USER, containerPathId), queryClient);
    await unmount();
    return [...latest].sort();
}

describe('useUnreadCommentChatNames', () => {
    test('names each card of the container that holds an unread reply, mention or assignment', async () => {
        const names = await unreadNamesFor([
            row('comment-reply', chatActivityTag({ ...BOARD, chatName: 'a.eigenchat' })),
            row('mention-comment', chatMentionTag({ ...BOARD, chatName: 'b.eigenchat' }, 'me@example.com')),
            row('assigned', commentAssignedTag({ ...BOARD, chatName: 'c.eigenchat' })),
        ]);
        expect(names).toEqual(['a.eigenchat', 'b.eigenchat', 'c.eigenchat']);
    });

    test('leaves out read rows, other containers and standalone chats', async () => {
        const names = await unreadNamesFor([
            row('comment-reply', chatActivityTag({ ...BOARD, chatName: 'read.eigenchat' }), true),
            row('comment-reply', chatActivityTag({ ...BOARD, pathId: 'other-doc', chatName: 'x.eigenchat' })),
            row('chat-message', chatActivityTag(BOARD)),
            row('file-event', `file-event:${BOARD.pathId}`),
        ]);
        expect(names).toEqual([]);
    });
});
