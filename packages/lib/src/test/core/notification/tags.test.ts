import { describe, expect, test } from 'bun:test';
import {
    accessRequestTag,
    chatActivityTag,
    chatMentionTag,
    chatThreadKey,
    commentAssignedTag,
    fileEventTag,
    parseAccessRequestTag,
    parseChatNotificationThread,
    parseFileEventTag,
    parseNotificationPath,
    parseShareTag,
    shareTag,
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

    // Byte-identical to what the assignee PATCH route has always persisted, so existing rows still match.
    test('an assignment is tagged with the card it points at', () => {
        expect(commentAssignedTag(COMMENT)).toBe('assigned:owner-1:mount-1:doc-1:comment-123-abc.eigenchat');
    });

    test('every tag parses back to the thread it was built from', () => {
        expect(parseChatNotificationThread('chat-message', chatActivityTag(CHAT))).toEqual({ ...CHAT });
        expect(parseChatNotificationThread('mention-chat', chatMentionTag(CHAT, 'bob@eigen.is'))).toEqual({ ...CHAT });
        expect(parseChatNotificationThread('comment-reply', chatActivityTag(COMMENT))).toEqual({ ...COMMENT });
        expect(parseChatNotificationThread('mention-comment', chatMentionTag(COMMENT, 'bob@eigen.is'))).toEqual({
            ...COMMENT,
        });
        expect(parseChatNotificationThread('assigned', commentAssignedTag(COMMENT))).toEqual({ ...COMMENT });
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

    // Opening the card clears the assignment: only the assignee is ever sent the row, so the reader
    // that matches it is the assignee's own card.
    test('an assignment shares the key of the card that clears it', () => {
        const thread = parseChatNotificationThread('assigned', commentAssignedTag(COMMENT));
        expect(thread && chatThreadKey(thread)).toBe(chatThreadKey(COMMENT));
        expect(thread && chatThreadKey(thread)).not.toBe(chatThreadKey({ ...COMMENT, chatName: 'other.eigenchat' }));
    });

    // The bug this pins: the card passed the comment chat's own pathId, which no tag carries.
    test('a comment notification matches the container pathId, not the comment chat', () => {
        const thread = parseChatNotificationThread('comment-reply', chatActivityTag(COMMENT));
        expect(thread && chatThreadKey(thread)).toBe(chatThreadKey(COMMENT));
        expect(thread && chatThreadKey(thread)).not.toBe(chatThreadKey({ pathId: 'chat-1' }));
    });
});

const PATH = { ownerId: 'owner-1', mountId: 'mount-1', pathId: 'file-1' };

describe('file notification tags', () => {
    test('a share, an access request and a file event parse back to the path they were built from', () => {
        expect(shareTag(PATH)).toBe('share:owner-1:mount-1:file-1');
        expect(parseShareTag(shareTag(PATH))).toEqual(PATH);
        expect(accessRequestTag(PATH, 'bob@eigen.is')).toBe('access-request:owner-1:mount-1:file-1:bob@eigen.is');
        expect(parseAccessRequestTag(accessRequestTag(PATH, 'bob@eigen.is'))).toEqual({
            ...PATH,
            email: 'bob@eigen.is',
        });
        expect(fileEventTag(PATH)).toBe('file-event:owner-1:mount-1:file-1');
        expect(parseFileEventTag(fileEventTag(PATH))).toEqual(PATH);
    });

    test('a tag of another kind parses to nothing', () => {
        expect(parseShareTag(fileEventTag(PATH))).toBeNull();
        expect(parseAccessRequestTag(shareTag(PATH))).toBeNull();
        expect(parseFileEventTag(shareTag(PATH))).toBeNull();
    });
});

describe('the path a notification names', () => {
    const MENTION = 'bob@eigen.is';

    test('a share, an access request and a file event name the path in their tag', () => {
        expect(parseNotificationPath('share', shareTag(PATH))).toEqual(PATH);
        expect(parseNotificationPath('access-request', accessRequestTag(PATH, MENTION))).toEqual(PATH);
        expect(parseNotificationPath('file-event', fileEventTag(PATH))).toEqual(PATH);
    });

    test('a chat message and a chat mention name the chat', () => {
        const chat = { ownerId: CHAT.ownerId, mountId: CHAT.mountId, pathId: CHAT.pathId };
        expect(parseNotificationPath('chat-message', chatActivityTag(CHAT))).toEqual(chat);
        expect(parseNotificationPath('mention-chat', chatMentionTag(CHAT, MENTION))).toEqual(chat);
    });

    test('a comment, a comment mention and an assignment name the container, not the thread', () => {
        const container = { ownerId: COMMENT.ownerId, mountId: COMMENT.mountId, pathId: COMMENT.pathId };
        expect(parseNotificationPath('comment-reply', chatActivityTag(COMMENT))).toEqual(container);
        expect(parseNotificationPath('mention-comment', chatMentionTag(COMMENT, MENTION))).toEqual(container);
        expect(parseNotificationPath('assigned', commentAssignedTag(COMMENT))).toEqual(container);
    });

    test('mail, calendar, admin alerts and unshares name none, whatever their tag holds', () => {
        expect(parseNotificationPath('mail', 'mail:new')).toBeNull();
        expect(parseNotificationPath('calendar-share', 'calendar-share:cal-1:owner-1')).toBeNull();
        expect(parseNotificationPath('calendar-unshare', 'calendar-share:cal-1:owner-1')).toBeNull();
        for (const type of ['calendar-invite', 'calendar-invite-updated', 'calendar-invite-cancelled']) {
            expect(parseNotificationPath(type, 'calendar-invite:event-1:1700000000000')).toBeNull();
        }
        expect(parseNotificationPath('admin-alert', 'backup-verify-owner-1')).toBeNull();
        expect(parseNotificationPath('unshare', shareTag(PATH))).toBeNull();
    });
});
