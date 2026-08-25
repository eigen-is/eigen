import { beforeAll, describe, expect, test } from 'bun:test';
import type { DriveACL, InviteResult } from '@workspace/lib/types';
import {
    assertJson,
    authedRequest,
    driveGet,
    driveGetList,
    drivePost,
    drivePut,
    findOrFail,
    getTestContext,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
const BOB_EMAIL = 'bob@test.eigen.is';
const CHARLIE_EMAIL = 'charlie@test.eigen.is';

function invite(token: string, ownerId: string, mountId: string, chatId: string, email: string) {
    return authedRequest(token, `/chat/${ownerId}/${mountId}/${chatId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });
}

describe('ACL Bubbling', () => {
    let ctx: TestCtx;
    let aliceMountId: string;
    let aliceRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        aliceMountId = mounts![0].id;
        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        aliceRootId = root.id;
    });

    describe('standalone chat (not inside a container)', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'standalone-room' },
            );
            chatId = chat.id;

            // Share chat with Bob so he can write
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${chatId}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: true }],
            });
        });

        test('owner invite sets ACL on the chat itself', async () => {
            const res = await invite(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                chatId,
                CHARLIE_EMAIL,
            );
            const body = await assertJson<InviteResult>(res);
            expect(body.alreadyHasAccess).toBe(false);
            expect(body.targetPathId).toBe(chatId);

            const path = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${chatId}`);
            expect(path.acl).toContainEqual({ id: CHARLIE_EMAIL, read: true, write: true });
        });

        test('duplicate invite returns alreadyHasAccess', async () => {
            const res = await invite(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                chatId,
                CHARLIE_EMAIL,
            );
            const body = await assertJson<InviteResult>(res);
            expect(body.alreadyHasAccess).toBe(true);
        });

        test('editor can invite to standalone chat', async () => {
            const res = await invite(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                chatId,
                'newuser@test.eigen.is',
            );
            const body = await assertJson<InviteResult>(res);
            expect(body.alreadyHasAccess).toBe(false);
            expect(body.targetPathId).toBe(chatId);
        });
    });

    describe('embedded chat inside eigendoc', () => {
        let docId: string;
        let chatId: string;

        beforeAll(async () => {
            const doc = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/doc`,
                { fileName: 'acl-bubble-doc' },
            );
            docId = doc.id;

            // Create chat inside the doc
            const chat = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${docId}/create/chat`,
                { fileName: 'discussion' },
            );
            chatId = chat.id;

            // Share doc with Bob (write) — Bob inherits write on the embedded chat
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${docId}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: true }],
            });
        });

        test('invite via embedded chat sets ACL on the container doc', async () => {
            const res = await invite(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                chatId,
                CHARLIE_EMAIL,
            );
            const body = await assertJson<InviteResult>(res);
            expect(body.alreadyHasAccess).toBe(false);
            expect(body.targetPathId).toBe(docId);

            // ACL is on the doc, not the chat
            const docPath = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${docId}`,
            );
            expect(docPath.acl).toContainEqual({ id: CHARLIE_EMAIL, read: true, write: true });

            const chatPath = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${chatId}`,
            );
            const chatCharlie = chatPath.acl?.find((e: DriveACL) => e.id === CHARLIE_EMAIL);
            expect(chatCharlie).toBeUndefined();
        });

        test('editor invite via embedded chat also sets ACL on container doc', async () => {
            const res = await invite(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                chatId,
                'editor-invite@test.eigen.is',
            );
            const body = await assertJson<InviteResult>(res);
            expect(body.targetPathId).toBe(docId);

            const docPath = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${docId}`,
            );
            expect(docPath.acl).toContainEqual({ id: 'editor-invite@test.eigen.is', read: true, write: true });
        });

        test('already has access on container returns alreadyHasAccess', async () => {
            // Bob already has access on the doc
            const res = await invite(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, chatId, BOB_EMAIL);
            const body = await assertJson<InviteResult>(res);
            expect(body.alreadyHasAccess).toBe(true);
        });
    });

    describe('chat inside folder inside eigendoc (nested)', () => {
        let docId: string;
        let chatId: string;

        beforeAll(async () => {
            const doc = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/doc`,
                { fileName: 'nested-container-doc' },
            );
            docId = doc.id;

            // CollabDocument.create auto-creates a "chat/" folder inside the doc.
            // Get it from folder contents to create our embedded chat inside it.
            const contents = await driveGetList(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${docId}`,
            );
            const chatFolder = findOrFail(contents, (p) => p.name === 'chat');

            const chat = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${chatFolder.id}/create/chat`,
                { fileName: 'nested-discussion' },
            );
            chatId = chat.id;
        });

        test('invite resolves to outermost collab container (doc)', async () => {
            const res = await invite(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, chatId, BOB_EMAIL);
            const body = await assertJson<InviteResult>(res);
            expect(body.targetPathId).toBe(docId);

            const docPath = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${docId}`,
            );
            expect(docPath.acl).toContainEqual({ id: BOB_EMAIL, read: true, write: true });
        });
    });

    describe('validation and permissions', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'perm-test-room' },
            );
            chatId = chat.id;
        });

        test('invalid email returns 400', async () => {
            const res = await invite(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                chatId,
                'not-an-email',
            );
            expect(res.status).toBe(400);
        });

        test('user without write permission on chat gets 403', async () => {
            // Bob has no access at all
            const res = await invite(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, chatId, CHARLIE_EMAIL);
            expect(res.status).toBe(403);
        });

        test('viewer on chat gets 403', async () => {
            // Give Bob read-only on the chat
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${chatId}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: false }],
            });

            const res = await invite(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, chatId, CHARLIE_EMAIL);
            expect(res.status).toBe(403);

            // Cleanup
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${chatId}/acl`, {
                remove: [BOB_EMAIL],
            });
        });

        test('email is case-insensitive', async () => {
            const res1 = await invite(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                chatId,
                'CaseTest@Example.COM',
            );
            expect(res1.status).toBe(200);

            // Same email different case is a duplicate
            const res2 = await invite(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                chatId,
                'casetest@example.com',
            );
            const body = await assertJson<InviteResult>(res2);
            expect(body.alreadyHasAccess).toBe(true);
        });

        test('self-invite is allowed', async () => {
            const res = await invite(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                chatId,
                ctx.alice.user.email,
            );
            expect(res.status).toBe(200);
        });
    });

    describe('chat write but no container write', () => {
        let chatId: string;

        beforeAll(async () => {
            const doc = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/doc`,
                { fileName: 'no-doc-write-test' },
            );

            const chat = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${doc.id}/create/chat`,
                { fileName: 'restricted-chat' },
            );
            chatId = chat.id;

            // Give Bob write on the chat only, NOT on the doc
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${chatId}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: true }],
            });
        });

        test('user with chat write but no container write gets 403', async () => {
            const res = await invite(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, chatId, CHARLIE_EMAIL);
            expect(res.status).toBe(403);
        });
    });

    describe('sharingRestricted on container', () => {
        let docId: string;
        let chatId: string;

        beforeAll(async () => {
            const doc = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/doc`,
                { fileName: 'restricted-container-doc' },
            );
            docId = doc.id;

            const chat = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${docId}/create/chat`,
                { fileName: 'restricted-container-chat' },
            );
            chatId = chat.id;

            // Share doc with Bob (write) + restrict sharing
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${docId}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: true }],
                sharingRestricted: true,
            });
        });

        test('editor blocked from inviting when container is sharing-restricted', async () => {
            const res = await invite(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, chatId, CHARLIE_EMAIL);
            expect(res.status).toBe(403);

            // ACL unchanged
            const docPath = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${docId}`,
            );
            const charlieEntry = docPath.acl?.find((e: DriveACL) => e.id === CHARLIE_EMAIL);
            expect(charlieEntry).toBeUndefined();
        });

        test('owner can still invite when container is sharing-restricted', async () => {
            const res = await invite(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                chatId,
                CHARLIE_EMAIL,
            );
            const body = await assertJson<InviteResult>(res);
            expect(body.targetPathId).toBe(docId);
        });

        test('editor can invite after owner removes restriction', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${docId}/acl`, {
                add: [
                    { id: BOB_EMAIL, read: true, write: true },
                    { id: CHARLIE_EMAIL, read: true, write: true },
                ],
                sharingRestricted: false,
            });

            const res = await invite(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                chatId,
                'unrestricted-invite@test.eigen.is',
            );
            expect(res.status).toBe(200);
        });
    });

    describe('nonexistent chat', () => {
        test('invite to nonexistent chat returns 404', async () => {
            const res = await invite(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                'nonexistent-id',
                BOB_EMAIL,
            );
            expect(res.status).toBe(404);
        });
    });
});
