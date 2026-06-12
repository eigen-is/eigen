import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DrivePath } from '@workspace/lib/types';
import type { PathWatchStatus, WatchedItem } from '@workspace/lib/types/file-history';
import type { Notification } from '@workspace/lib/types/notification';
import type { SSEvent, SSEventNotificationCreated } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import { user as userSchema } from '../../auth-schema.ts';
import { auth, getAuthDrizzleDb } from '../lib/auth/auth';
import { getHome } from '../lib/home';
import type { TestContext } from './setup';
import {
    assertJson,
    authedRequest,
    drivePost,
    drivePut,
    driveUpload,
    driveUploadMultiple,
    getTestContext,
} from './setup';

function fileEventTag(ownerId: string, mountId: string, pathId: string): string {
    return `file-event:${ownerId}:${mountId}:${pathId}`;
}

async function notificationsFor(userId: string): Promise<Notification[]> {
    const home = await getHome(userId);
    return home.notifications.list();
}

// In-process SSE listener — same idiom as sse.test.ts's collectSSE.
function collectSSE(userId: string): { events: SSEvent[]; stop: () => void } {
    const events: SSEvent[] = [];
    let home: Awaited<ReturnType<typeof getHome>> | null = null;
    const listener = (event: SSEvent) => events.push(event);
    const setup = getHome(userId).then((h) => {
        home = h;
        h.subscribeSSE(listener);
    });
    return {
        events,
        stop: () => {
            setup.then(() => {
                if (home) home.unsubscribeSSE(listener);
            });
        },
    };
}

describe('File watch + fan-out', () => {
    let ctx: TestContext;
    let aliceToken: string;
    let bobToken: string;
    let aliceOwnerId: string;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        aliceToken = ctx.alice.user.sessionToken;
        bobToken = ctx.bob.user.sessionToken;
        aliceOwnerId = ctx.alice.user.id;

        const mounts = await assertJson<{ id: string }[]>(
            await authedRequest(aliceToken, `/drive/${aliceOwnerId}/mounts`),
        );
        mountId = mounts[0].id;
        const root = await assertJson<{ id: string }>(
            await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${mountId}/root`),
        );
        rootId = root.id;
    });

    async function createFolder(name: string): Promise<DrivePath> {
        return drivePost(aliceToken, aliceOwnerId, mountId, `folder/${rootId}`, { folderName: name });
    }

    async function shareWith(pathId: string, email: string): Promise<void> {
        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${pathId}/acl`, {
            acl: [{ id: email, read: true, write: false }],
        });
    }

    function watch(token: string, pathId: string): Promise<Response> {
        return authedRequest(token, `/drive/${aliceOwnerId}/${mountId}/path/${pathId}/watch`, { method: 'POST' });
    }

    function unwatch(token: string, pathId: string): Promise<Response> {
        return authedRequest(token, `/drive/${aliceOwnerId}/${mountId}/path/${pathId}/watch`, { method: 'DELETE' });
    }

    async function watchStatus(token: string, pathId: string): Promise<PathWatchStatus> {
        return assertJson<PathWatchStatus>(
            await authedRequest(token, `/drive/${aliceOwnerId}/${mountId}/path/${pathId}/watch`),
        );
    }

    test('watch requires read access: 403 unshared, 200 after share', async () => {
        const folder = await createFolder('WatchACL');

        const denied = await watch(bobToken, folder.id);
        expect(denied.status).toBe(403);

        await shareWith(folder.id, ctx.bob.user.email);
        const allowed = await watch(bobToken, folder.id);
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toEqual({ success: true });
    });

    test('folder watch cascades to nested descendants', async () => {
        const folder = await createFolder('WatchCascade');
        await shareWith(folder.id, ctx.bob.user.email);
        await watch(bobToken, folder.id);

        // Nested subfolder created by alice → bob notified (burst tag on the watched folder)
        const sub = await drivePost<DrivePath>(aliceToken, aliceOwnerId, mountId, `folder/${folder.id}`, {
            folderName: 'Nested',
        });
        // File two levels deep → uploaded (burst tag on subfolder), then renamed (tag on file)
        const file = await driveUpload(aliceToken, aliceOwnerId, mountId, sub.id, new File(['x'], 'deep.txt'));
        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${file.id}/rename`, { newName: 'deeper.txt' });

        const notifications = await notificationsFor(ctx.bob.user.id);
        const tags = notifications.filter((n) => n.type === 'file-event').map((n) => n.tag);
        expect(tags).toContain(fileEventTag(aliceOwnerId, mountId, folder.id));
        expect(tags).toContain(fileEventTag(aliceOwnerId, mountId, sub.id));
        expect(tags).toContain(fileEventTag(aliceOwnerId, mountId, file.id));

        const renamed = notifications.find((n) => n.tag === fileEventTag(aliceOwnerId, mountId, file.id));
        expect(renamed?.title).toBe('Alice Test renamed deeper.txt');
        expect(renamed?.actorEmail).toBe(ctx.alice.user.email);
    });

    test('events in an unwatched sibling tree do not notify', async () => {
        const watched = await createFolder('WatchSiblingA');
        const sibling = await createFolder('WatchSiblingB');
        await shareWith(watched.id, ctx.bob.user.email);
        await shareWith(sibling.id, ctx.bob.user.email);
        await watch(bobToken, watched.id);

        const file = await driveUpload(aliceToken, aliceOwnerId, mountId, sibling.id, new File(['x'], 'sib.txt'));
        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${file.id}/rename`, { newName: 'sib2.txt' });

        const notifications = await notificationsFor(ctx.bob.user.id);
        const siblingTags = [
            fileEventTag(aliceOwnerId, mountId, sibling.id),
            fileEventTag(aliceOwnerId, mountId, file.id),
        ];
        expect(notifications.some((n) => siblingTags.includes(n.tag ?? ''))).toBe(false);
    });

    test('the actor is never notified about their own events', async () => {
        const folder = await createFolder('WatchSelf');
        const ownWatch = await watch(aliceToken, folder.id);
        expect(ownWatch.status).toBe(200);

        const file = await driveUpload(aliceToken, aliceOwnerId, mountId, folder.id, new File(['x'], 'self.txt'));
        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${file.id}/rename`, { newName: 'self2.txt' });

        const notifications = await notificationsFor(ctx.alice.user.id);
        const ownTags = [fileEventTag(aliceOwnerId, mountId, folder.id), fileEventTag(aliceOwnerId, mountId, file.id)];
        expect(notifications.some((n) => ownTags.includes(n.tag ?? ''))).toBe(false);
    });

    test('a watcher whose share was revoked is silently skipped', async () => {
        const folder = await createFolder('WatchRevoked');
        await shareWith(folder.id, ctx.bob.user.email);
        await watch(bobToken, folder.id);
        const file = await driveUpload(aliceToken, aliceOwnerId, mountId, folder.id, new File(['x'], 'rev.txt'));

        // Revoke bob's access, then mutate inside the still-watched folder
        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${folder.id}/acl`, { acl: [] });
        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${file.id}/rename`, { newName: 'rev2.txt' });

        const notifications = await notificationsFor(ctx.bob.user.id);
        expect(notifications.some((n) => n.tag === fileEventTag(aliceOwnerId, mountId, file.id))).toBe(false);
    });

    test('trash notifies folder watchers via the pre-trash chain', async () => {
        const folder = await createFolder('WatchTrash');
        await shareWith(folder.id, ctx.bob.user.email);
        await watch(bobToken, folder.id);
        const file = await driveUpload(aliceToken, aliceOwnerId, mountId, folder.id, new File(['x'], 'doomed.txt'));

        const res = await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${mountId}/path/${file.id}`, {
            method: 'DELETE',
        });
        expect(res.status).toBe(200);

        const notifications = await notificationsFor(ctx.bob.user.id);
        const trashed = notifications.find((n) => n.tag === fileEventTag(aliceOwnerId, mountId, file.id));
        expect(trashed?.title).toBe('Alice Test trashed doomed.txt');
    });

    test('restore notifies via the post-restore chain', async () => {
        const folder = await createFolder('WatchRestore');
        await shareWith(folder.id, ctx.bob.user.email);
        await watch(bobToken, folder.id);
        const file = await driveUpload(aliceToken, aliceOwnerId, mountId, folder.id, new File(['x'], 'phoenix.txt'));

        await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${mountId}/path/${file.id}`, { method: 'DELETE' });
        const res = await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${mountId}/trash/${file.id}/restore`, {
            method: 'POST',
        });
        expect(res.status).toBe(200);

        // Same tag as the trash notification — the upsert leaves the latest verb
        const notifications = await notificationsFor(ctx.bob.user.id);
        const restored = notifications.find((n) => n.tag === fileEventTag(aliceOwnerId, mountId, file.id));
        expect(restored?.title).toBe('Alice Test restored phoenix.txt');
    });

    test('move notifies watchers of both the old and new parent', async () => {
        const oldParent = await createFolder('WatchMoveFrom');
        const newParent = await createFolder('WatchMoveTo');
        await shareWith(oldParent.id, ctx.bob.user.email);
        await shareWith(newParent.id, ctx.charlie.user.email);
        await watch(bobToken, oldParent.id);
        await watch(ctx.charlie.user.sessionToken, newParent.id);
        const file = await driveUpload(aliceToken, aliceOwnerId, mountId, oldParent.id, new File(['x'], 'mover.txt'));

        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${file.id}/move`, { targetParentId: newParent.id });

        const tag = fileEventTag(aliceOwnerId, mountId, file.id);
        const bobMoved = (await notificationsFor(ctx.bob.user.id)).find((n) => n.tag === tag);
        const charlieMoved = (await notificationsFor(ctx.charlie.user.id)).find((n) => n.tag === tag);
        expect(bobMoved?.title).toBe('Alice Test moved mover.txt');
        expect(charlieMoved?.title).toBe('Alice Test moved mover.txt');
    });

    test('permanent delete notifies watchers and removes the watch rows', async () => {
        const folder = await createFolder('WatchDelete');
        await shareWith(folder.id, ctx.bob.user.email);
        await watch(bobToken, folder.id);
        const file = await driveUpload(aliceToken, aliceOwnerId, mountId, folder.id, new File(['x'], 'gone.txt'));
        await watch(bobToken, file.id);

        await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${mountId}/path/${file.id}`, { method: 'DELETE' });
        const res = await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${mountId}/trash/${file.id}`, {
            method: 'DELETE',
        });
        expect(res.status).toBe(200);

        const deleted = (await notificationsFor(ctx.bob.user.id)).find(
            (n) => n.tag === fileEventTag(aliceOwnerId, mountId, file.id),
        );
        expect(deleted?.title).toBe('Alice Test deleted gone.txt');

        // path_watchers cascade: bob's watch on the file is gone, the folder watch survives
        const watches = await assertJson<WatchedItem[]>(
            await authedRequest(bobToken, `/drive/${aliceOwnerId}/watches`),
        );
        expect(watches.some((w) => w.pathId === file.id)).toBe(false);
        expect(watches.some((w) => w.pathId === folder.id)).toBe(true);
    });

    test('events on items already in trash do not fan out', async () => {
        const folder = await createFolder('WatchTrashedNoFanout');
        await shareWith(folder.id, ctx.bob.user.email);
        await watch(bobToken, folder.id);
        const file = await driveUpload(aliceToken, aliceOwnerId, mountId, folder.id, new File(['x'], 'silent.txt'));

        await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${mountId}/path/${file.id}`, { method: 'DELETE' });

        // ACL change on the trashed item records history but must not notify (trashed guard)
        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${file.id}/acl`, {
            acl: [{ id: ctx.charlie.user.email, read: true, write: false }],
        });

        const notifications = await notificationsFor(ctx.bob.user.id);
        const latest = notifications.find((n) => n.tag === fileEventTag(aliceOwnerId, mountId, file.id));
        // Still the trash notification — the acl-changed fan-out was suppressed
        expect(latest?.title).toBe('Alice Test trashed silent.txt');
    });

    test('coalesce: repeat events within the window upsert one row and suppress the broadcast', async () => {
        const folder = await createFolder('WatchCoalesce');
        await shareWith(folder.id, ctx.bob.user.email);
        await watch(bobToken, folder.id);
        const file = await driveUpload(aliceToken, aliceOwnerId, mountId, folder.id, new File(['x'], 'co.txt'));

        const sse = collectSSE(ctx.bob.user.id);
        await new Promise((r) => setTimeout(r, 50));

        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${file.id}/rename`, { newName: 'co1.txt' });
        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${file.id}/rename`, { newName: 'co2.txt' });

        await new Promise((r) => setTimeout(r, 50));
        sse.stop();

        const tag = fileEventTag(aliceOwnerId, mountId, file.id);
        const broadcasts = sse.events.filter(
            (e): e is SSEventNotificationCreated => e.type === SSEventType.NOTIFICATION_CREATED && 'tag' in e,
        );
        expect(broadcasts.filter((e) => e.tag === tag)).toHaveLength(1);

        const rows = (await notificationsFor(ctx.bob.user.id)).filter((n) => n.tag === tag);
        expect(rows).toHaveLength(1);
        expect(rows[0].title).toBe('Alice Test renamed co2.txt');
    });

    test('burst: multiple uploads into a watched folder collapse to one row tagged on the parent', async () => {
        const folder = await createFolder('WatchBurst');
        await shareWith(folder.id, ctx.bob.user.email);
        await watch(bobToken, folder.id);

        await driveUploadMultiple(aliceToken, aliceOwnerId, mountId, folder.id, [
            new File(['1'], 'b1.txt'),
            new File(['2'], 'b2.txt'),
            new File(['3'], 'b3.txt'),
        ]);

        const tag = fileEventTag(aliceOwnerId, mountId, folder.id);
        const rows = (await notificationsFor(ctx.bob.user.id)).filter((n) => n.tag === tag);
        expect(rows).toHaveLength(1);
        expect(rows[0].title).toContain('uploaded');
    });

    test('watch status reports direct watches and the nearest watched ancestor', async () => {
        const folder = await createFolder('WatchStatus');
        await shareWith(folder.id, ctx.bob.user.email);
        const file = await driveUpload(aliceToken, aliceOwnerId, mountId, folder.id, new File(['x'], 'st.txt'));

        await watch(bobToken, folder.id);

        expect(await watchStatus(bobToken, folder.id)).toEqual({ direct: true });
        expect(await watchStatus(bobToken, file.id)).toEqual({
            direct: false,
            viaAncestor: { pathId: folder.id, name: 'WatchStatus' },
        });
        // Alice's own status is independent of bob's
        expect((await watchStatus(aliceToken, folder.id)).direct).toBe(false);

        const res = await unwatch(bobToken, folder.id);
        expect(res.status).toBe(200);
        expect((await watchStatus(bobToken, folder.id)).direct).toBe(false);
    });

    test('GET /drive/:ownerId/watches lists watched items with last-event info', async () => {
        const folder = await createFolder('WatchList');
        await shareWith(folder.id, ctx.bob.user.email);
        const file = await driveUpload(
            aliceToken,
            aliceOwnerId,
            mountId,
            folder.id,
            new File(['x'], 'listed.txt', { type: 'text/plain' }),
        );
        await watch(bobToken, file.id);

        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${file.id}/rename`, { newName: 'listed2.txt' });

        const watches = await assertJson<WatchedItem[]>(
            await authedRequest(bobToken, `/drive/${aliceOwnerId}/watches`),
        );
        const item = watches.find((w) => w.pathId === file.id);
        expect(item).toBeDefined();
        expect(item!.ownerId).toBe(aliceOwnerId);
        expect(item!.mountId).toBe(mountId);
        expect(item!.name).toBe('listed2.txt');
        expect(item!.type).toBe('file');
        expect(item!.mimeType).toBe('text/plain');
        expect(item!.watchedAt).toBeTruthy();
        expect(item!.lastEventType).toBe('renamed');
        expect(item!.lastActorEmail).toBe(ctx.alice.user.email);
    });

    test('watches the caller can no longer read are filtered out', async () => {
        const folder = await createFolder('WatchListRevoked');
        await shareWith(folder.id, ctx.bob.user.email);
        await watch(bobToken, folder.id);

        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${folder.id}/acl`, { acl: [] });

        const watches = await assertJson<WatchedItem[]>(
            await authedRequest(bobToken, `/drive/${aliceOwnerId}/watches`),
        );
        expect(watches.some((w) => w.pathId === folder.id)).toBe(false);
    });

    test('guests cannot watch', async () => {
        // Guest creation idiom from guest-auth.test.ts: create, flip role, sign in
        const email = `watch-guest-${randomUUID()}@external.com`;
        const password = randomUUID();
        const created = await auth.api.createUser({ body: { email, password, name: 'Watch Guest', role: 'user' } });
        getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, created.user.id)).run();
        const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password } });
        const guestToken =
            (signIn.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/)?.[1] ?? '';

        const folder = await createFolder('WatchGuest');
        await shareWith(folder.id, email);

        const res = await watch(guestToken, folder.id);
        expect(res.status).toBe(403);
    });
});
