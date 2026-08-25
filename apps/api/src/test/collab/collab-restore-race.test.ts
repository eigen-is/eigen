// Regression net for the collab/Yjs audit's chat-restore-wipe P1 (deep-dive doc removed — see git history):
// restoreContainer's replaceContainerDataDb deletes + recreates a chat's data.db under the
// container lock, while ChatRoom.init (built fresh per request by Drive.getChat) lazily
// auto-creates a missing data.db. Before the fix, a message posted in the delete→recreate
// window provisioned a second empty data.db; the restore's createFileFromTemp then threw on the
// duplicate name and the chat was left on the empty db with its earlier messages gone.
// ChatRoom.init now takes the same container lock and re-checks existence under it.
// (The broader collab restore/close/snapshot race matrix that verified the sound Yjs core lives
// in docs/superpowers/api-audit-deepdive-tests/collab-restore-race.test.ts.)
import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getHome } from '../../lib/home';
import { chatGet, chatPost, driveGet, drivePost, getTestContext } from '../setup';

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
