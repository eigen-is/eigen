import { beforeAll, describe, expect, test } from 'bun:test';
import type { CommentEntry, DrivePath } from '@workspace/lib/types';
import type { FileEvent } from '@workspace/lib/types/file-history';
import type { Notification } from '@workspace/lib/types/notification';
import { eq } from 'drizzle-orm';
import { COMMENT_INDEX_DB_CONFIG } from '../../lib/chat/comment-db-config';
import * as commentSchema from '../../lib/chat/comment-schema';
import { getHome } from '../../lib/home';
import { assertJson, authedRequest, driveGet, drivePost, drivePut, findOrFail, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

function patchAssignee(
    token: string,
    ownerId: string,
    mountId: string,
    pathId: string,
    chatName: string,
    assignee: string | null,
    title?: string,
) {
    return authedRequest(token, `/collab/${ownerId}/${mountId}/${pathId}/comments/${chatName}/assignee`, {
        method: 'PATCH',
        body: JSON.stringify(title === undefined ? { assignee } : { assignee, title }),
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
    let chatFolderId: string;
    const chatName = 'assign-flow.eigenchat';

    async function listComments(): Promise<CommentEntry[]> {
        return assertJson<CommentEntry[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${mountId}/${docId}/comments`,
            ),
        );
    }

    async function assignedEvents(): Promise<FileEvent[]> {
        const events = await assertJson<FileEvent[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/path/${docId}/history`,
            ),
        );
        return events.filter((e) => e.eventType === 'assigned');
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
        chatFolderId = findOrFail(children, (c: DrivePath) => c.name === 'chat').id;
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
            'Fix header',
        );
        expect(await assertJson<{ success: boolean }>(res)).toEqual({ success: true });

        const row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === chatName);
        expect(row.assignee).toBe(ctx.bob.user.email);
        // Client-posted title is cached on the comment row.
        expect(row.title).toBe('Fix header');
    });

    test('a real assignment records an "assigned" activity event with the card title', async () => {
        const row = findOrFail(await assignedEvents(), (e: FileEvent) => {
            const d = e.details;
            return !!d && 'assignee' in d && d.chatName === chatName;
        });
        expect(row.actorEmail).toBe(ctx.alice.user.email);
        const details = row.details && 'assignee' in row.details ? row.details : null;
        expect(details?.assignee).toBe(ctx.bob.user.email);
        expect(details?.card).toBe('Fix header');
    });

    test('assignment notifies the assignee', async () => {
        const tag = `assigned:${ctx.alice.user.id}:${mountId}:${docId}:${chatName}`;
        const notification = findOrFail(await notificationsFor(ctx.bob.user.id), (n: Notification) => n.tag === tag);
        expect(notification.type).toBe('assigned');
        expect(notification.title).toContain('assign-doc');
        expect(notification.actorEmail).toBe(ctx.alice.user.email);
    });

    test('re-assigning the already-selected member is a no-op: no new event, no new notification', async () => {
        // bob is still the assignee from the earlier test — re-selecting him must not re-record.
        const tag = `assigned:${ctx.alice.user.id}:${mountId}:${docId}:${chatName}`;
        const eventsBefore = (await assignedEvents()).length;
        expect(eventsBefore).toBe(1);
        const notifsBefore = (await notificationsFor(ctx.bob.user.id)).filter((n) => n.tag === tag).length;

        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            chatName,
            ctx.bob.user.email,
        );
        expect(res.status).toBe(200);

        // Exactly ONE 'assigned' row still — file history has no dedupe window on this path.
        expect((await assignedEvents()).length).toBe(1);
        expect((await notificationsFor(ctx.bob.user.id)).filter((n) => n.tag === tag).length).toBe(notifsBefore);
        const row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === chatName);
        expect(row.assignee).toBe(ctx.bob.user.email);
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
        const eventsBefore = (await assignedEvents()).length;

        const res = await patchAssignee(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, chatName, null);
        expect(res.status).toBe(200);

        const row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === chatName);
        expect(row.assignee).toBeNull();

        const after = (await notificationsFor(ctx.bob.user.id)).filter((n) => n.tag === tag).length;
        expect(after).toBe(before);
        // Unassign stays silent in Recent Activity too — no new 'assigned' row.
        expect((await assignedEvents()).length).toBe(eventsBefore);
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

    test('assigning on a REAL chat whose index row was deleted heals it (ensureComment)', async () => {
        // Legacy case: a real .eigenchat thread predating row-seeding. Create it (seeding gives it a
        // row), delete the row directly, then assign — ensureComment must re-create it, not 404.
        await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${chatFolderId}/create/chat`,
            { fileName: 'heal-flow' },
        );
        const healName = 'heal-flow.eigenchat';

        const home = await getHome(ctx.alice.user.id);
        const commentsDb = await home.drive.getChildByName(mountId, docId, 'comments.db');
        const managed = await home.drive.openDatabase(mountId, COMMENT_INDEX_DB_CONFIG, commentsDb!.id);
        await managed.db.delete(commentSchema.comments).where(eq(commentSchema.comments.chatName, healName));
        expect((await listComments()).some((r) => r.chatName === healName)).toBe(false);

        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            healName,
            ctx.bob.user.email,
        );
        expect(res.status).toBe(200);

        const row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === healName);
        expect(row.assignee).toBe(ctx.bob.user.email);
    });

    test('assigning on a nonexistent chatName → 404, no row, no event, no notification', async () => {
        // No .eigenchat exists under this name, so it can't be healed — the write must 404 rather
        // than mint a phantom row + immutable 'assigned' event + dead-link notification.
        const ghostName = 'ghost-thread.eigenchat';
        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            ghostName,
            ctx.bob.user.email,
        );
        expect(res.status).toBe(404);

        expect((await listComments()).some((r) => r.chatName === ghostName)).toBe(false);
        const ghostEvent = (await assignedEvents()).some((e: FileEvent) => {
            const d = e.details;
            return !!d && 'assignee' in d && d.chatName === ghostName;
        });
        expect(ghostEvent).toBe(false);
        const tag = `assigned:${ctx.alice.user.id}:${mountId}:${docId}:${ghostName}`;
        expect((await notificationsFor(ctx.bob.user.id)).some((n) => n.tag === tag)).toBe(false);
    });
});
