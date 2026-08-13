import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DrivePath } from '@workspace/lib/types';
import type { FileEvent, PathWatchStatus } from '@workspace/lib/types/file-history';
import type { Notification } from '@workspace/lib/types/notification';
import type { SSEventNotificationCreated } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { user as userSchema } from '../../auth-schema';
import { auth, getAuthDrizzleDb } from '../lib/auth/auth';
import { getHome } from '../lib/home';
import { getUserById } from '../lib/user';
import type { TestContext } from './setup';
import {
    assertJson,
    authedRequest,
    chatPost,
    collectSSE,
    driveGet,
    drivePost,
    drivePut,
    driveUpload,
    driveUploadMultiple,
    findOrFail,
    getTestContext,
} from './setup';

function fileEventTag(ownerId: string, mountId: string, pathId: string): string {
    return `file-event:${ownerId}:${mountId}:${pathId}`;
}

async function notificationsFor(userId: string): Promise<Notification[]> {
    const home = await getHome(userId);
    return home.notifications.list();
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
            add: [{ id: email, read: true, write: false }],
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
        expect(renamed?.title).toBe('Alice Test renamed');
        expect(renamed?.body).toBe('deep.txt → deeper.txt');
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
        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${folder.id}/acl`, { remove: [ctx.bob.user.email] });
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
        expect(trashed?.title).toBe('Alice Test trashed');
        expect(trashed?.body).toBe('doomed.txt');
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
        expect(restored?.title).toBe('Alice Test restored');
        expect(restored?.body).toBe('phoenix.txt');
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
        expect(bobMoved?.title).toBe('Alice Test moved');
        expect(bobMoved?.body).toBe('mover.txt');
        expect(charlieMoved?.title).toBe('Alice Test moved');
        expect(charlieMoved?.body).toBe('mover.txt');
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
        expect(deleted?.title).toBe('Alice Test deleted');
        expect(deleted?.body).toBe('gone.txt');

        // path_watchers cascade: bob's watch on the file is gone, the folder watch survives
        const watches = await assertJson<DrivePath[]>(await authedRequest(bobToken, `/drive/${aliceOwnerId}/watches`));
        expect(watches.some((w) => w.id === file.id)).toBe(false);
        expect(watches.some((w) => w.id === folder.id)).toBe(true);
    });

    test('events on items already in trash do not fan out', async () => {
        const folder = await createFolder('WatchTrashedNoFanout');
        await shareWith(folder.id, ctx.bob.user.email);
        await watch(bobToken, folder.id);
        const file = await driveUpload(aliceToken, aliceOwnerId, mountId, folder.id, new File(['x'], 'silent.txt'));

        await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${mountId}/path/${file.id}`, { method: 'DELETE' });

        // An event on a trashed item is dropped entirely (recordFileEvent returns on
        // path.trashedAt) — neither recorded nor fanned out.
        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${file.id}/acl`, {
            add: [{ id: ctx.charlie.user.email, read: true, write: false }],
        });

        const notifications = await notificationsFor(ctx.bob.user.id);
        const latest = notifications.find((n) => n.tag === fileEventTag(aliceOwnerId, mountId, file.id));
        // Still the trash notification — the acl-changed event never fired
        expect(latest?.title).toBe('Alice Test trashed');
        expect(latest?.body).toBe('silent.txt');
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
        expect(rows[0].title).toBe('Alice Test renamed');
        expect(rows[0].body).toBe('co1.txt → co2.txt');
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

    test('GET /drive/:ownerId/watches lists watched items as hydrated paths', async () => {
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

        const watches = await assertJson<DrivePath[]>(await authedRequest(bobToken, `/drive/${aliceOwnerId}/watches`));
        const item = watches.find((w) => w.id === file.id);
        expect(item).toBeDefined();
        expect(item!.ownerId).toBe(aliceOwnerId);
        expect(item!.mountId).toBe(mountId);
        expect(item!.name).toBe('listed2.txt');
        expect(item!.type).toBe('file');
        expect(item!.mimeType).toBe('text/plain');
    });

    test('watches the caller can no longer read are filtered out', async () => {
        const folder = await createFolder('WatchListRevoked');
        await shareWith(folder.id, ctx.bob.user.email);
        await watch(bobToken, folder.id);

        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${folder.id}/acl`, { remove: [ctx.bob.user.email] });

        const watches = await assertJson<DrivePath[]>(await authedRequest(bobToken, `/drive/${aliceOwnerId}/watches`));
        expect(watches.some((w) => w.id === folder.id)).toBe(false);
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

describe('File events: collab edits, client posts, comments', () => {
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

    function createDoc(name: string, type: 'doc' | 'stickies' = 'doc'): Promise<DrivePath> {
        return drivePost(aliceToken, aliceOwnerId, mountId, `folder/${rootId}/create/${type}`, { fileName: name });
    }

    async function shareWith(pathId: string, email: string, write = false): Promise<void> {
        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${pathId}/acl`, {
            add: [{ id: email, read: true, write }],
        });
    }

    async function history(pathId: string): Promise<FileEvent[]> {
        return assertJson<FileEvent[]>(
            await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${mountId}/path/${pathId}/history`),
        );
    }

    // recordFileEvent is fire-and-forget from the collab update handler — poll briefly.
    async function waitForEdited(pathId: string, count: number): Promise<FileEvent[]> {
        let edited: FileEvent[] = [];
        for (let i = 0; i < 40; i++) {
            edited = (await history(pathId)).filter((e) => e.eventType === 'edited');
            if (edited.length >= count) return edited;
            await new Promise((r) => setTimeout(r, 25));
        }
        return edited;
    }

    function syncUpdateMessage(doc: Y.Doc): Uint8Array {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0); // MESSAGE_SYNC (mirrors collabDocument.ts)
        syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
        return encoding.toUint8Array(encoder);
    }

    function postClientEvent(token: string, pathId: string, body: Record<string, unknown>): Promise<Response> {
        return authedRequest(token, `/drive/${aliceOwnerId}/${mountId}/path/${pathId}/history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    describe('collab edited attribution', () => {
        test('a WS-origin update records an edited event attributed to the connection user', async () => {
            const doc = await createDoc('EditAttrib');
            const home = await getHome(aliceOwnerId);
            const collab = await home.drive.getCollabDocument(mountId, doc.id);
            const aliceUser = await getUserById(ctx.alice.user.id);
            expect(aliceUser).not.toBeNull();
            const conn = { send() {}, readyState: 1 } as unknown as Parameters<typeof collab.handleMessage>[0];
            collab.subscribe(aliceUser!, conn);

            const edit = new Y.Doc();
            edit.getMap('m').set('k', 'v');
            collab.handleMessage(conn, syncUpdateMessage(edit), true);

            const edited = await waitForEdited(doc.id, 1);
            expect(edited).toHaveLength(1);
            expect(edited[0].actorEmail).toBe(ctx.alice.user.email);
        });

        test('edits from two users record two attributed rows', async () => {
            const doc = await createDoc('EditTwoUsers');
            const home = await getHome(aliceOwnerId);
            const collab = await home.drive.getCollabDocument(mountId, doc.id);
            const aliceUser = await getUserById(ctx.alice.user.id);
            const bobUser = await getUserById(ctx.bob.user.id);
            const connA = { send() {}, readyState: 1 } as unknown as Parameters<typeof collab.handleMessage>[0];
            const connB = { send() {}, readyState: 1 } as unknown as Parameters<typeof collab.handleMessage>[0];
            collab.subscribe(aliceUser!, connA);
            collab.subscribe(bobUser!, connB);

            const editA = new Y.Doc();
            editA.getMap('m').set('a', '1');
            collab.handleMessage(connA, syncUpdateMessage(editA), true);
            const editB = new Y.Doc();
            editB.getMap('m').set('b', '2');
            collab.handleMessage(connB, syncUpdateMessage(editB), true);

            const edited = await waitForEdited(doc.id, 2);
            expect(edited.map((e) => e.actorEmail).sort()).toEqual([ctx.alice.user.email, ctx.bob.user.email].sort());
        });

        test('repeat edits from the same user within the throttle window record one row', async () => {
            const doc = await createDoc('EditThrottle');
            const home = await getHome(aliceOwnerId);
            const collab = await home.drive.getCollabDocument(mountId, doc.id);
            const aliceUser = await getUserById(ctx.alice.user.id);
            const conn = { send() {}, readyState: 1 } as unknown as Parameters<typeof collab.handleMessage>[0];
            collab.subscribe(aliceUser!, conn);

            const first = new Y.Doc();
            first.getMap('m').set('k1', 'v1');
            collab.handleMessage(conn, syncUpdateMessage(first), true);
            const second = new Y.Doc();
            second.getMap('m').set('k2', 'v2');
            collab.handleMessage(conn, syncUpdateMessage(second), true);

            await waitForEdited(doc.id, 1);
            // Let any stray second write land before asserting the negative
            await new Promise((r) => setTimeout(r, 100));
            const edited = (await history(doc.id)).filter((e) => e.eventType === 'edited');
            expect(edited).toHaveLength(1);
        });

        test('server-origin updates do not record edited events', async () => {
            const doc = await createDoc('EditServerOrigin');
            const home = await getHome(aliceOwnerId);
            const collab = await home.drive.getCollabDocument(mountId, doc.id);

            collab.doc.transact(() => {
                collab.doc.getMap('m').set('k', 'v');
            });

            await new Promise((r) => setTimeout(r, 150));
            const edited = (await history(doc.id)).filter((e) => e.eventType === 'edited');
            expect(edited).toHaveLength(0);
        });
    });

    describe('client-posted history events', () => {
        const stickyMoved = {
            eventType: 'sticky-moved',
            details: { card: 'Buy milk', toColumn: 'Done', cardId: 'card-1' },
        };

        test('a writer can post a sticky-moved event with details', async () => {
            const board = await createDoc('ClientSticky', 'stickies');
            const res = await postClientEvent(aliceToken, board.id, stickyMoved);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ success: true });

            const moved = (await history(board.id)).find((e) => e.eventType === 'sticky-moved');
            expect(moved).toBeDefined();
            expect(moved!.details).toEqual(stickyMoved.details);
            expect(moved!.actorEmail).toBe(ctx.alice.user.email);
        });

        test('a read-only collaborator cannot post client events', async () => {
            const board = await createDoc('ClientStickyRO', 'stickies');
            await shareWith(board.id, ctx.bob.user.email);
            const res = await postClientEvent(bobToken, board.id, stickyMoved);
            expect(res.status).toBe(403);
        });

        test('server-only event types are rejected by the route schema', async () => {
            const board = await createDoc('ClientStickyServerOnly', 'stickies');
            const res = await postClientEvent(aliceToken, board.id, { eventType: 'created', details: {} });
            expect(res.status).toBe(422);
        });

        test('identical client events within the dedupe window record one row', async () => {
            const board = await createDoc('ClientStickyDedupe', 'stickies');
            await postClientEvent(aliceToken, board.id, stickyMoved);
            await postClientEvent(aliceToken, board.id, stickyMoved);
            const moved = (await history(board.id)).filter((e) => e.eventType === 'sticky-moved');
            expect(moved).toHaveLength(1);
        });

        test('a writer can post a sticky-added event with the card title', async () => {
            const board = await createDoc('ClientStickyAdd', 'stickies');
            const details = { card: 'Write tests', toColumn: 'Todo', cardId: 'card-2' };
            const res = await postClientEvent(aliceToken, board.id, { eventType: 'sticky-added', details });
            expect(res.status).toBe(200);
            const added = (await history(board.id)).find((e) => e.eventType === 'sticky-added');
            expect(added?.details).toEqual(details);
        });

        test('sticky-removed is accepted and recorded with the card title', async () => {
            const board = await createDoc('ClientVocab', 'stickies');
            const details = { card: 'Old card', cardId: 'card-3' };
            const res = await postClientEvent(aliceToken, board.id, { eventType: 'sticky-removed', details });
            expect(res.status).toBe(200);
            const recorded = await history(board.id);
            expect(recorded.find((e) => e.eventType === 'sticky-removed')?.details).toEqual(details);
        });

        test('deferred semantic types (slide-reordered, sheet-rows-inserted) are rejected by the route', async () => {
            const board = await createDoc('ClientDeferred', 'stickies');
            for (const body of [
                { eventType: 'slide-reordered', details: { slideId: 's1', newIndex: 2 } },
                { eventType: 'sheet-rows-inserted', details: { count: 3 } },
            ]) {
                const res = await postClientEvent(aliceToken, board.id, body);
                expect(res.status).toBe(422);
            }
        });

        // Per-card comment threads + attachment media are created inside the container;
        // they must never surface in its activity timeline (the leaking "created
        // comment-…" rows the design suppresses).
        test('entities created inside an eigendoc container stay out of the timeline', async () => {
            const board = await createDoc('SuppressBoard', 'stickies');
            const thread = await drivePost(aliceToken, aliceOwnerId, mountId, `folder/${board.id}/create/chat`, {
                fileName: 'comment-internal',
            });
            expect(thread.id).toBeDefined();
            const evts = await history(board.id);
            expect(evts.some((e) => e.pathName === 'comment-internal')).toBe(false);
        });

        test('entities inside a standalone chat container are also suppressed', async () => {
            const chat = await drivePost(aliceToken, aliceOwnerId, mountId, `folder/${rootId}/create/chat`, {
                fileName: 'TeamChat',
            });
            const sub = await drivePost(aliceToken, aliceOwnerId, mountId, `folder/${chat.id}`, {
                folderName: 'media2',
            });
            expect(sub.id).toBeDefined();
            const evts = await history(chat.id);
            expect(evts.some((e) => e.pathName === 'media2')).toBe(false);
        });
    });

    describe('commented events', () => {
        async function createCommentChat(docId: string, name: string): Promise<DrivePath> {
            const children = await driveGet<DrivePath[]>(aliceToken, aliceOwnerId, mountId, `folder/${docId}`);
            const chatFolder = findOrFail(children, (c) => c.name === 'chat');
            return drivePost(aliceToken, aliceOwnerId, mountId, `folder/${chatFolder.id}/create/chat`, {
                fileName: name,
            });
        }

        test('a comment records a commented row on the container and notifies watchers once', async () => {
            const doc = await createDoc('CommentWatch');
            await shareWith(doc.id, ctx.bob.user.email);
            await authedRequest(bobToken, `/drive/${aliceOwnerId}/${mountId}/path/${doc.id}/watch`, {
                method: 'POST',
            });
            const chat = await createCommentChat(doc.id, 'c1');

            await chatPost(aliceToken, aliceOwnerId, mountId, `${chat.id}/messages`, { content: 'first comment' });

            const commented = (await history(doc.id)).filter((e) => e.eventType === 'commented');
            expect(commented).toHaveLength(1);
            expect(commented[0].pathId).toBe(doc.id);
            // toMatchObject, not toEqual: chat.ts additively records `chatName` in commented
            // details (its deep-link field) — assert the preview here, leave chatName to chat's tests.
            expect(commented[0].details).toMatchObject({ preview: 'first comment' });
            expect(commented[0].actorEmail).toBe(ctx.alice.user.email);

            // bob (watcher, never commented) gets exactly ONE file-event row, no comment-reply
            const notifications = await notificationsFor(ctx.bob.user.id);
            const fileEvents = notifications.filter((n) => n.tag === fileEventTag(aliceOwnerId, mountId, doc.id));
            expect(fileEvents).toHaveLength(1);
            expect(fileEvents[0].title).toBe('Alice Test commented on "CommentWatch"');
            expect(fileEvents[0].body).toBe('“first comment”');
            expect(notifications.some((n) => n.type === 'comment-reply' && (n.tag ?? '').includes(doc.id))).toBe(false);
        });

        test('mentioned watchers get the mention notification, not the file-event', async () => {
            const doc = await createDoc('CommentMention');
            await shareWith(doc.id, ctx.charlie.user.email);
            await authedRequest(
                ctx.charlie.user.sessionToken,
                `/drive/${aliceOwnerId}/${mountId}/path/${doc.id}/watch`,
                { method: 'POST' },
            );
            const chat = await createCommentChat(doc.id, 'c2');

            await chatPost(aliceToken, aliceOwnerId, mountId, `${chat.id}/messages`, {
                content: `hey ${ctx.charlie.user.email}`,
            });

            const notifications = await notificationsFor(ctx.charlie.user.id);
            expect(notifications.some((n) => n.type === 'mention-comment' && (n.tag ?? '').includes(doc.id))).toBe(
                true,
            );
            expect(notifications.some((n) => n.tag === fileEventTag(aliceOwnerId, mountId, doc.id))).toBe(false);
        });

        test('whispers never record commented rows', async () => {
            const doc = await createDoc('CommentWhisper');
            await shareWith(doc.id, ctx.bob.user.email);
            const chat = await createCommentChat(doc.id, 'c3');

            await chatPost(aliceToken, aliceOwnerId, mountId, `${chat.id}/messages`, {
                content: 'psst, secret',
                type: 'whisper',
                whisperTo: ctx.bob.user.email,
            });

            const commented = (await history(doc.id)).filter((e) => e.eventType === 'commented');
            expect(commented).toHaveLength(0);
        });
    });
});
