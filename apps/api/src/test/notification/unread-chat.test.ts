import { beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Notification } from '@workspace/lib/types/notification';
import { getHome } from '../../lib/home';
import { assertJson, authedRequest, createTestUser, getTestContext, type TestUser } from '../setup';

let user: TestUser;

beforeAll(async () => {
    await getTestContext();
    user = await createTestUser(`unread-chat-${randomUUID()}@test.eigen.is`, 'testpassword123', 'Unread Chat');
});

// The bell loads the newest 50 rows of every type, so the unread chat dots ask for theirs alone: a chat
// message buried under newer notifications still lights its chat, and opening the chat still clears it.
test('the unread chat notifications are listed however many newer rows bury them', async () => {
    const home = await getHome(user.id);
    home.notifications.persist({ type: 'chat-message', title: 'Old chat', tag: 'chat-message:o:m:buried-chat' });
    const read = home.notifications.persist({
        type: 'chat-message',
        title: 'Read chat',
        tag: 'chat-message:o:m:read-chat',
    });
    home.notifications.markRead(read.id);
    for (let i = 0; i < 55; i++) home.notifications.persist({ type: 'share', title: `Share ${i}`, tag: `share:${i}` });

    const unreadChat = await assertJson<Notification[]>(
        await authedRequest(user.sessionToken, `/notifications/${user.id}/unread-chat`),
    );
    expect(unreadChat.map((n) => n.tag)).toEqual(['chat-message:o:m:buried-chat']);
});
