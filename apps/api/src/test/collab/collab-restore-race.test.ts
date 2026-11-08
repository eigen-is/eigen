// Regression net for the collab/Yjs audit's chat-restore-wipe P1:
// restoreContainer's replaceContainerDataDb rewrites a chat's data.db in place under the container
// lock, while posts keep opening the room. Posts racing a restore must leave one data.db and a coherent
// message set.
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { ChatMessage } from '@workspace/lib/types/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getHome } from '../../lib/home';
import { STALL_BOUND_MS, settlesWithin } from '../fault-storage-helpers';
import { assertJson, authedRequest, chatGet, chatPost, driveGet, drivePost, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
type DriveT = Awaited<ReturnType<typeof getHome>>['drive'];

const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));

describe('chat restore racing message posts', () => {
    let ctx: TestCtx;
    let drive: DriveT;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = mounts![0].id;
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        drive = (await getHome(ctx.alice.user.id)).drive;
    });

    test('one data.db, coherent message set', async () => {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;
        for (let i = 0; i < 6; i++) {
            const chat = await drivePost<DrivePath>(token, ownerId, mountId, `folder/${rootId}/create/chat`, {
                fileName: `race-chat-restore-${i}`,
            });
            await chatPost(token, ownerId, mountId, `${chat.id}/messages`, { content: 'v1' });
            const saved = await drive.saveVersion(mountId, chat.id);
            await chatPost(token, ownerId, mountId, `${chat.id}/messages`, { content: 'v2' });

            const posts = (async () => {
                for (let j = 0; j < 5; j++) {
                    try {
                        await chatPost(token, ownerId, mountId, `${chat.id}/messages`, { content: `during-${i}-${j}` });
                    } catch {
                        // a post may legitimately 4xx mid-restore — the invariants below are what matter
                    }
                    if (j % 2 === 0) await macrotask();
                }
            })();
            const [restoreRes] = await Promise.allSettled([
                drive.restoreContainer(mountId, chat.id, saved.name),
                posts,
            ]);

            // Invariant 1: exactly one data.db child, always.
            const contents = await drive.getFolderContents(mountId, chat.id);
            const dataDbs = contents.filter((c) => c.name === 'data.db');
            expect(dataDbs.length).toBe(1);

            // Invariant 2: messages must be readable and coherent.
            const messages = await chatGet<{ content: string }[]>(token, ownerId, mountId, `${chat.id}/messages`);
            const bodies = messages.map((m) => m.content);
            if (restoreRes.status === 'fulfilled') {
                expect(bodies).toContain('v1'); // restored base present
                expect(bodies).not.toContain('v2'); // post-snapshot message rolled back
            } else {
                console.log(`  [iter ${i}] restore rejected:`, (restoreRes.reason as Error).message);
                expect(bodies).toContain('v2'); // failed restore must leave pre-race state intact
            }
        }
    }, 120_000);
});

// A chat request that is still using data.db when a version restore of the chat replaces it. The
// restore waits for the request, so the request never reads a closed database.
describe('chat request in flight across a version restore', () => {
    let ctx: TestCtx;
    let drive: DriveT;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        drive = (await getHome(ctx.alice.user.id)).drive;
    });

    // A chat with one saved version, holding 'v1', and a newer message 'v2' the restore rolls back.
    async function chatWithVersion(fileName: string): Promise<{ chat: DrivePath; version: string }> {
        const { sessionToken: token, id: ownerId } = ctx.alice.user;
        const chat = await drivePost<DrivePath>(token, ownerId, mountId, `folder/${rootId}/create/chat`, { fileName });
        await chatPost(token, ownerId, mountId, `${chat.id}/messages`, { content: 'v1' });
        const saved = await drive.saveVersion(mountId, chat.id);
        await chatPost(token, ownerId, mountId, `${chat.id}/messages`, { content: 'v2' });
        return { chat, version: saved.name };
    }

    test('a post parked after its write finishes across the restore, never with a 500', async () => {
        const { chat, version } = await chatWithVersion('post-across-restore');
        const entered = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        const members = drive.getEffectiveMembers.bind(drive);
        const spy = spyOn(drive, 'getEffectiveMembers').mockImplementationOnce(async (...args) => {
            entered.resolve();
            await gate.promise;
            return members(...args);
        });
        try {
            const posting = authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${mountId}/${chat.id}/messages`,
                {
                    method: 'POST',
                    body: JSON.stringify({ content: 'in flight' }),
                    headers: { 'Content-Type': 'application/json' },
                },
            );
            await entered.promise;
            await drive.restoreContainer(mountId, chat.id, version);
            gate.resolve();
            expect([200, 503]).toContain((await posting).status);
        } finally {
            gate.resolve();
            spy.mockRestore();
        }
    });

    test('a read that holds data.db makes the restore wait, and reads the open database', async () => {
        const { chat, version } = await chatWithVersion('read-across-restore');
        const entered = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        const withDatabase = drive.withDatabase.bind(drive);
        const spy = spyOn(drive, 'withDatabase').mockImplementationOnce((mount, config, pathId, fn) =>
            withDatabase(mount, config, pathId, async (db) => {
                entered.resolve();
                await gate.promise;
                return fn(db);
            }),
        );
        try {
            const reading = authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${mountId}/${chat.id}/messages`,
            );
            await entered.promise;
            const restoring = drive.restoreContainer(mountId, chat.id, version);
            expect(await settlesWithin([restoring], STALL_BOUND_MS)).toBe(false);
            gate.resolve();
            const messages = await assertJson<ChatMessage[]>(await reading);
            expect(messages.map((m) => m.content)).toEqual(['v1', 'v2']);
            await restoring;

            const restored = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `${chat.id}/messages`,
            );
            expect(restored.map((m) => m.content)).toEqual(['v1']);
        } finally {
            gate.resolve();
            spy.mockRestore();
        }
    });
});
