import { describe, expect, test } from 'bun:test';
import {
    chatActivityTag,
    chatMentionTag,
    chatThreadKey,
    parseChatNotificationThread,
} from '../../../core/notification/tags';

const CHAT = { ownerId: 'owner-1', mountId: 'mount-1', pathId: 'chat-1' };
const COMMENT = { ownerId: 'owner-1', mountId: 'mount-1', pathId: 'doc-1', chatName: 'comment-123-abc.eigenchat' };

describe('chat notification tags', () => {
    test('a standalone chat is tagged with its own path', () => {
        expect(chatActivityTag(CHAT)).toBe('chat-message:owner-1:mount-1:chat-1');
        expect(chatMentionTag(CHAT, 'bob@eigen.is')).toBe('mention:owner-1:mount-1:chat-1:bob@eigen.is');
    });

    test('a comment is tagged with its container and its own chat name', () => {
        expect(chatActivityTag(COMMENT)).toBe('comment-reply:owner-1:mount-1:doc-1:comment-123-abc.eigenchat');
        expect(chatMentionTag(COMMENT, 'bob@eigen.is')).toBe(
            'mention:owner-1:mount-1:doc-1:comment-123-abc.eigenchat:bob@eigen.is',
        );
    });

    test('every tag parses back to the thread it was built from', () => {
        expect(parseChatNotificationThread('chat-message', chatActivityTag(CHAT))).toEqual({ ...CHAT });
        expect(parseChatNotificationThread('mention-chat', chatMentionTag(CHAT, 'bob@eigen.is'))).toEqual({ ...CHAT });
        expect(parseChatNotificationThread('comment-reply', chatActivityTag(COMMENT))).toEqual({ ...COMMENT });
        expect(parseChatNotificationThread('mention-comment', chatMentionTag(COMMENT, 'bob@eigen.is'))).toEqual({
            ...COMMENT,
        });
    });

    test('a tag of another kind is not a chat thread', () => {
        expect(parseChatNotificationThread('share', 'share:owner-1:mount-1:doc-1')).toBeNull();
        expect(parseChatNotificationThread('file-event', 'file-event:owner-1:mount-1:doc-1')).toBeNull();
    });

    // The card that was opened is the one whose notifications clear: two threads in one document
    // never share a key, and the container's own key is neither.
    test('the thread key tells two comments in one document apart', () => {
        const other = { ...COMMENT, chatName: 'comment-456-def.eigenchat' };
        expect(chatThreadKey(COMMENT)).not.toBe(chatThreadKey(other));
        expect(chatThreadKey(COMMENT)).not.toBe(chatThreadKey({ pathId: COMMENT.pathId }));
    });

    // The bug this pins: the card passed the comment chat's own pathId, which no tag carries.
    test('a comment notification matches the container pathId, not the comment chat', () => {
        const thread = parseChatNotificationThread('comment-reply', chatActivityTag(COMMENT));
        expect(thread && chatThreadKey(thread)).toBe(chatThreadKey(COMMENT));
        expect(thread && chatThreadKey(thread)).not.toBe(chatThreadKey({ pathId: 'chat-1' }));
    });
});
