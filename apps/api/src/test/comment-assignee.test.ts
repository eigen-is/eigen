import { beforeAll, describe, expect, test } from 'bun:test';
import type { CommentEntry, DrivePath } from '@workspace/lib/types';
import type { Notification } from '@workspace/lib/types/notification';
import { getHome } from '../lib/home';
import { assertJson, authedRequest, driveGet, drivePost, drivePut, findOrFail, getTestContext } from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

function patchAssignee(
    token: string,
    ownerId: string,
    mountId: string,
    pathId: string,
    chatName: string,
    assignee: string | null,
) {
    return authedRequest(token, `/collab/${ownerId}/${mountId}/${pathId}/comments/${chatName}/assignee`, {
        method: 'PATCH',
        body: JSON.stringify({ assignee }),
        headers: { 'Content-Type': 'application/json' },
    });
}

async function notificationsFor(userId: string): Promise<Notification[]> {
    const home = await getHome(userId);
    return home.notifications.list();
}

describe('Comment assignee', () => {
    let ctx: TestCtx;
    let mountId: string;
    let docId: string;
    const chatName = 'assign-flow.eigenchat';

    async function listComments(): Promise<CommentEntry[]> {
        return assertJson<CommentEntry[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${mountId}/${docId}/comments`,
            ),
        );
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = mounts![0].id;

        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        const doc = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${root.id}/create/doc`,
            { fileName: 'assign-doc' },
        );
        docId = doc.id;

        const children = await driveGet<DrivePath[]>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${docId}`,
        );
        const chatFolderId = findOrFail(children, (c: DrivePath) => c.name === 'chat').id;
        await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${chatFolderId}/create/chat`,
            { fileName: 'assign-flow' },
        );

        // Share the doc with bob (write) so he is an assignable effective member.
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${docId}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: true }],
        });
    });

    test('assign requires write permission', async () => {
        // charlie was never granted access → canWrite is false → 403.
        const res = await patchAssignee(
            ctx.charlie.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            chatName,
            ctx.charlie.user.email,
        );
        expect(res.status).toBe(403);
    });

    test('assigning a non-member email → 400', async () => {
        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            chatName,
            'stranger@nowhere.test',
        );
        expect(res.status).toBe(400);
    });

    test('assign stores lowercased and shows up in the list', async () => {
        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            chatName,
            ctx.bob.user.email.toUpperCase(),
        );
        expect(await assertJson<{ success: boolean }>(res)).toEqual({ success: true });

        const row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === chatName);
        expect(row.assignee).toBe(ctx.bob.user.email);
    });

    test('assignment notifies the assignee', async () => {
        const tag = `assigned:${ctx.alice.user.id}:${mountId}:${docId}:${chatName}`;
        const notification = findOrFail(await notificationsFor(ctx.bob.user.id), (n: Notification) => n.tag === tag);
        expect(notification.type).toBe('assigned');
        expect(notification.title).toContain('assign-doc');
        expect(notification.actorEmail).toBe(ctx.alice.user.email);
    });

    test('self-assign does not notify', async () => {
        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            chatName,
            ctx.alice.user.email,
        );
        expect(res.status).toBe(200);
        // Alice is never assigned by anyone else, so she must have no 'assigned' rows.
        expect((await notificationsFor(ctx.alice.user.id)).some((n) => n.type === 'assigned')).toBe(false);
    });

    test('unassign clears and does not notify', async () => {
        const tag = `assigned:${ctx.alice.user.id}:${mountId}:${docId}:${chatName}`;
        const before = (await notificationsFor(ctx.bob.user.id)).filter((n) => n.tag === tag).length;

        const res = await patchAssignee(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, chatName, null);
        expect(res.status).toBe(200);

        const row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === chatName);
        expect(row.assignee).toBeNull();

        const after = (await notificationsFor(ctx.bob.user.id)).filter((n) => n.tag === tag).length;
        expect(after).toBe(before);
    });

    test('assigning an unregistered invitee succeeds and silently skips the notification', async () => {
        const ghost = 'ghost-invitee@test.eigen.is';
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${docId}/acl`, {
            add: [{ id: ghost, read: true, write: false }],
        });

        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            chatName,
            ghost,
        );
        expect(res.status).toBe(200);

        const row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === chatName);
        expect(row.assignee).toBe(ghost);
    });

    test('assigning on a chatName with no index row creates it (ensureComment)', async () => {
        // No chat was ever created under this name, so seedCommentRow never ran and there is no
        // comments.db row — the route's ensureComment must create it before assigning.
        const legacyName = 'legacy-no-row.eigenchat';
        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            legacyName,
            ctx.bob.user.email,
        );
        expect(res.status).toBe(200);

        const row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === legacyName);
        expect(row.assignee).toBe(ctx.bob.user.email);
    });
});
