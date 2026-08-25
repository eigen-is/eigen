import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath, EffectiveMember } from '@workspace/lib/types/drive';
import { assertJson, authedRequest, driveGet, drivePost, drivePut, findOrFail, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
const BOB_EMAIL = 'bob@test.eigen.is';
const CHARLIE_EMAIL = 'charlie@test.eigen.is';

function getEffectiveMembers(token: string, ownerId: string, mountId: string, pathId: string) {
    return authedRequest(token, `/drive/${ownerId}/${mountId}/path/${pathId}/effective-members`);
}

describe('Effective Members', () => {
    let ctx: TestCtx;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = mounts![0].id;
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

    describe('owner-only path', () => {
        let folderId: string;

        beforeAll(async () => {
            const folder = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${rootId}`,
                { folderName: 'members-test' },
            );
            folderId = folder.id;
        });

        test('returns owner as the only member', async () => {
            const res = await getEffectiveMembers(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, folderId);
            const members = await assertJson<EffectiveMember[]>(res);
            expect(members).toHaveLength(1);
            expect(members[0].email).toBe(ctx.alice.user.email);
            expect(members[0].read).toBe(true);
            expect(members[0].write).toBe(true);
        });
    });

    describe('direct ACL', () => {
        let folderId: string;

        beforeAll(async () => {
            const folder = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${rootId}`,
                { folderName: 'direct-acl-test' },
            );
            folderId = folder.id;

            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${folderId}/acl`, {
                add: [
                    { id: BOB_EMAIL, read: true, write: true },
                    { id: CHARLIE_EMAIL, read: true, write: false },
                ],
            });
        });

        test('includes owner and all ACL entries', async () => {
            const res = await getEffectiveMembers(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, folderId);
            const members = await assertJson<EffectiveMember[]>(res);
            expect(members).toHaveLength(3);

            const alice = findOrFail(members, (m) => m.email === ctx.alice.user.email);
            const bob = findOrFail(members, (m) => m.email === BOB_EMAIL);
            const charlie = findOrFail(members, (m) => m.email === CHARLIE_EMAIL);

            expect(alice.write).toBe(true);

            expect(bob.write).toBe(true);

            expect(charlie.read).toBe(true);
            expect(charlie.write).toBe(false);
        });

        test('shared user can also query effective members', async () => {
            const res = await getEffectiveMembers(ctx.bob.user.sessionToken, ctx.alice.user.id, mountId, folderId);
            const members = await assertJson<EffectiveMember[]>(res);
            expect(members).toHaveLength(3);
        });
    });

    describe('inherited ACL', () => {
        let parentId: string;
        let childId: string;

        beforeAll(async () => {
            const parent = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${rootId}`,
                { folderName: 'parent-inherit' },
            );
            parentId = parent.id;

            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${parentId}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: true }],
            });

            const child = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${parentId}`,
                { folderName: 'child-inherit' },
            );
            childId = child.id;
        });

        test('child inherits parent ACL entries', async () => {
            const res = await getEffectiveMembers(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, childId);
            const members = await assertJson<EffectiveMember[]>(res);

            const bob = findOrFail(members, (m) => m.email === BOB_EMAIL);
            expect(bob.read).toBe(true);
            expect(bob.write).toBe(true);
        });

        test('child direct ACL merges with inherited (most permissive wins)', async () => {
            // Give Charlie read-only on child
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${childId}/acl`, {
                add: [{ id: CHARLIE_EMAIL, read: true, write: false }],
            });

            const res = await getEffectiveMembers(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, childId);
            const members = await assertJson<EffectiveMember[]>(res);

            // Bob from parent + Charlie from child + Alice as owner
            expect(members).toHaveLength(3);
        });
    });

    describe('embedded chat inherits from container', () => {
        let docId: string;
        let chatId: string;

        beforeAll(async () => {
            const doc = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${rootId}/create/doc`,
                { fileName: 'members-doc' },
            );
            docId = doc.id;

            // Share doc with Bob
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${docId}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: true }],
            });

            // Create chat inside the doc
            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${docId}`,
            );
            const chatFolder = findOrFail(contents, (p) => p.name === 'chat');

            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${chatFolder.id}/create/chat`,
                { fileName: 'embedded-chat' },
            );
            chatId = chat.id;
        });

        test('chat effective members includes doc ACL entries', async () => {
            const res = await getEffectiveMembers(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, chatId);
            const members = await assertJson<EffectiveMember[]>(res);

            findOrFail(members, (m) => m.email === ctx.alice.user.email);
            findOrFail(members, (m) => m.email === BOB_EMAIL);
        });

        test('shared user can query chat effective members', async () => {
            const res = await getEffectiveMembers(ctx.bob.user.sessionToken, ctx.alice.user.id, mountId, chatId);
            const members = await assertJson<EffectiveMember[]>(res);
            findOrFail(members, (m) => m.email === BOB_EMAIL);
        });
    });

    describe('deduplication', () => {
        let folderId: string;

        beforeAll(async () => {
            const parent = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${rootId}`,
                { folderName: 'dedup-parent' },
            );

            // Bob as viewer on parent
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${parent.id}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: false }],
            });

            const child = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${parent.id}`,
                { folderName: 'dedup-child' },
            );
            folderId = child.id;

            // Bob as editor on child — should merge to editor (most permissive)
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${folderId}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: true }],
            });
        });

        test('duplicate entries are merged with most permissive winning', async () => {
            const res = await getEffectiveMembers(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, folderId);
            const members = await assertJson<EffectiveMember[]>(res);

            const bobs = members.filter((m) => m.email === BOB_EMAIL);
            expect(bobs).toHaveLength(1);
            expect(bobs[0].write).toBe(true);
        });
    });

    describe('permissions', () => {
        let folderId: string;

        beforeAll(async () => {
            const folder = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${rootId}`,
                { folderName: 'perm-members-test' },
            );
            folderId = folder.id;
        });

        test('user without access gets 403', async () => {
            const res = await getEffectiveMembers(ctx.bob.user.sessionToken, ctx.alice.user.id, mountId, folderId);
            expect(res.status).toBe(403);
        });

        test('nonexistent path gets 404', async () => {
            const res = await getEffectiveMembers(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                'nonexistent',
            );
            expect(res.status).toBe(404);
        });
    });
});
