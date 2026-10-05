import { beforeAll, expect, setSystemTime, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Notification } from '@workspace/lib/types/notification';
import { getHome } from '../../lib/home';
import { assertJson, authedRequest, createTestUser, getTestContext, type TestUser } from '../setup';

let user: TestUser;

beforeAll(async () => {
    await getTestContext();
    user = await createTestUser(`notification-list-${randomUUID()}@test.eigen.is`, 'testpassword123', 'List');
});

// Chat's unread dots read the bell's list, so an unread row buried under 50 newer read rows must still be on it.
test('the first page holds every unread row as well as the newest 50', async () => {
    const home = await getHome(user.id);
    const start = Date.now() - 60 * 60 * 1000;
    setSystemTime(new Date(start));
    home.notifications.persist({ type: 'chat-message', title: 'Old chat', tag: 'chat-message:o:m:buried-chat' });
    for (let i = 1; i <= 50; i++) {
        setSystemTime(new Date(start + i * 1000));
        const read = home.notifications.persist({ type: 'share', title: `Share ${i}`, tag: `share:${i}` });
        home.notifications.markRead(read.id);
    }
    setSystemTime();

    const list = await assertJson<Notification[]>(await authedRequest(user.sessionToken, `/notifications/${user.id}`));
    expect(list).toHaveLength(51);
    expect(list[0]?.tag).toBe('share:50');
    expect(list[50]?.tag).toBe('chat-message:o:m:buried-chat');
});
