import { beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CHAT_ROOM_DB_CONFIG } from '../../lib/chat/db-config';
import { messages } from '../../lib/chat/schema';
import { readChatContent } from '../../lib/document/chat';
import { getHome } from '../../lib/home';
import { driveGet, drivePost, getTestContext } from '../setup';

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let mountId: string;
let rootId: string;

beforeAll(async () => {
    ctx = await getTestContext();
    const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
    mountId = mounts![0].id;
    const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
    rootId = root.id;
});

// createdAt is whole seconds and the read pages back 512 rows at a time: a busy second spanning a page
// edge must not lose the rest of that second.
test('the search text of a chat keeps every message of a second that spans a page edge', async () => {
    const chat = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${rootId}/create/chat`,
        { fileName: 'Busy Second Chat' },
    );
    const home = await getHome(ctx.alice.user.id);
    const { mount, path } = await home.drive.resolveFile(mountId, chat.id);
    const dataDb = await mount.getChildByName(path.id, 'data.db');
    if (!dataDb) throw new Error('chat has no data.db');
    const managedDb = await mount.openDatabase(CHAT_ROOM_DB_CONFIG, dataDb.id);

    const createdAt = new Date('2026-10-05T12:00:00Z');
    const rows = Array.from({ length: 600 }, (_, i) => ({
        id: randomUUID(),
        authorEmail: ctx.alice.user.email,
        type: 'message' as const,
        content: `message ${i}`,
        createdAt,
    }));
    managedDb.db.insert(messages).values(rows).run();

    const text = await readChatContent(mount, path, 1_000_000);
    expect(text.trim().split('\n')).toHaveLength(600);
});
