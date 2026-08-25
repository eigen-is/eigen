import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { describeFileEvent, type FileEvent, toFileEventType } from '@workspace/lib/types/file-history';
import type { Notification } from '@workspace/lib/types/notification';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../../lib/core';
import { getHome } from '../../lib/home';
import { createDefaultMountConfig } from '../../lib/mount/helpers';
import { Mount } from '../../lib/mount/mount';
import { fileEvents } from '../../lib/mount/schema';
import { getUserById } from '../../lib/user';
import type { TestContext } from '../setup';
import {
    assertJson,
    authedRequest,
    collectSSE,
    driveDelete,
    driveGet,
    drivePost,
    drivePut,
    driveUpload,
    getTestContext,
} from '../setup';

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-file-history-${Date.now()}`);
const OWNER_ID = 'test-owner-id';
const MOUNT_ID = 'test-mount';

function createGetLocalDatabase(baseDir: string) {
    const captured = new Map<string, ManagedDatabase<SchemaType>>();
    const getter = async <S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string,
    ): Promise<ManagedDatabase<S>> => {
        const fullPath = join(baseDir, relativePath);
        const db = new ManagedDatabase(config, fullPath);
        await db.open(0);
        captured.set(relativePath, db as ManagedDatabase<SchemaType>);
        return db;
    };
    return { getter, captured };
}

beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

describe('file event phrasing', () => {
    test('known event types resolve to their phrase via describeFileEvent', () => {
        const file = { pathName: 'x.txt', pathType: 'file' } as const;
        expect(describeFileEvent({ ...file, eventType: 'edited', details: null }, 'own').action).toBe('edited');
        expect(describeFileEvent({ ...file, eventType: 'renamed', details: null }, 'own').action).toBe('renamed');
    });

    test('known event types pass through toFileEventType unchanged', () => {
        expect(toFileEventType('renamed')).toBe('renamed');
        expect(toFileEventType('commented')).toBe('commented');
    });

    // Persisted rows can hold a verb outside today's union — older builds, or the deferred
    // slide/sheet structural verbs that (per CLIENT_FILE_EVENT_TYPES) surface as the generic
    // 'edited' until the in-doc history feature consumes them. toFileEventType coerces those
    // at the read seam so FileEvent stays honestly typed and the activity timeline
    // can't hit "reading 'summary' of undefined".
    test('unknown/deferred event types coerce to edited at the read seam', () => {
        expect(toFileEventType('sheet-rows-inserted')).toBe('edited');
        expect(toFileEventType('slide-removed')).toBe('edited');
        expect(toFileEventType('totally-made-up')).toBe('edited');
    });
});

describe('describeFileEvent', () => {
    const base = { pathName: 'Roadmap.eigenstickies', pathType: 'stickies' } as const;
    test('sticky-moved, container ctx', () => {
        expect(
            describeFileEvent(
                { ...base, eventType: 'sticky-moved', details: { card: 'Fix flaky test', toColumn: 'Done' } },
                'container',
            ),
        ).toEqual({ action: 'moved a card in "Roadmap"', primary: 'Fix flaky test → Done' });
    });
    test('sticky-added, own ctx keeps column in action', () => {
        expect(
            describeFileEvent(
                { ...base, eventType: 'sticky-added', details: { card: 'Welcome', toColumn: 'To Do' } },
                'own',
            ),
        ).toEqual({ action: 'added a card to To Do', primary: 'Welcome' });
    });
    test('renamed shows old → new as primary in both ctx', () => {
        const e = { ...base, eventType: 'renamed', details: { oldName: 'a.txt', newName: 'b.txt' } } as const;
        expect(describeFileEvent(e, 'own').primary).toBe('a.txt → b.txt');
        expect(describeFileEvent(e, 'container').primary).toBe('a.txt → b.txt');
    });
    test('created: names the item in the own-ctx action, name as primary in container ctx', () => {
        const e = { pathName: 'notes.txt', pathType: 'file', eventType: 'created', details: null } as const;
        expect(describeFileEvent(e, 'own')).toEqual({ action: 'created "notes.txt"' });
        expect(describeFileEvent(e, 'container')).toEqual({ action: 'created', primary: 'notes.txt' });
    });
    test('commented quotes the preview and names the doc in container ctx', () => {
        const e = { ...base, eventType: 'commented', details: { preview: 'looks good' } } as const;
        expect(describeFileEvent(e, 'container')).toEqual({
            action: 'commented on "Roadmap"',
            primary: '“looks good”',
        });
    });
    test('acl-changed secondary joins the diff', () => {
        // as const only on eventType — a whole-object as const would make added/removed
        // readonly, which is not assignable to FileEventDetailsMap['acl-changed'].string[].
        const e = { ...base, eventType: 'acl-changed' as const, details: { added: ['a@x.nl'], removed: ['b@x.nl'] } };
        expect(describeFileEvent(e, 'own').secondary).toBe('Added a@x.nl · removed b@x.nl');
    });
});

describe('FileHistory', () => {
    let mount: Mount;
    let rootId: string;
    let metaDb: ManagedDatabase<SchemaType>;

    beforeAll(async () => {
        const config = createDefaultMountConfig(MOUNT_ID, 'local-key');
        const { getter, captured } = createGetLocalDatabase(TEST_DIR);
        mount = new Mount(OWNER_ID, TEST_DIR, config, getter);
        await mount.init();
        rootId = (await mount.getRootFolder())!.id;
        metaDb = captured.get(`mounts/${MOUNT_ID}/metadata.db`)!;
    });

    test('record and list a renamed event', async () => {
        const fileId = await mount.touchFile(rootId, 'a.txt', 'text/plain');
        await mount.history.record({
            pathId: fileId,
            eventType: 'renamed',
            actor: { id: 'u1', email: 'u1@test' },
            details: { oldName: 'a.txt', newName: 'b.txt' },
        });
        const events = await mount.history.list(fileId);
        expect(events).toHaveLength(1);
        expect(events[0].eventType).toBe('renamed');
        expect(events[0].details).toEqual({ oldName: 'a.txt', newName: 'b.txt' });
        expect(events[0].pathName).toBe('a.txt');
        expect(events[0].actorEmail).toBe('u1@test');
        expect(events[0].actorUserId).toBe('u1');
        expect(events[0].createdAt).toBeInstanceOf(Date);
    });

    test('folder timeline includes descendant events, ordered desc, limit respected', async () => {
        const folderId = await mount.createFolder(rootId, 'parent-folder');
        const subFolderId = await mount.createFolder(folderId, 'sub-folder');
        const fileId = await mount.touchFile(subFolderId, 'deep.txt', 'text/plain');

        // Record two events on the file so we can verify ordering + limit
        await mount.history.record({
            pathId: fileId,
            eventType: 'created',
            actor: { id: 'u2', email: 'u2@test' },
        });
        await mount.history.record({
            pathId: fileId,
            eventType: 'edited',
            actor: { id: 'u2', email: 'u2@test' },
        });

        const events = await mount.history.list(folderId);
        expect(events.length).toBeGreaterThanOrEqual(2);

        // Verify ordering: newest first
        for (let i = 1; i < events.length; i++) {
            expect(events[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(events[i].createdAt.getTime());
        }

        // pathName should resolve to the descendant file name
        const fileEventsForFile = events.filter((e) => e.pathId === fileId);
        expect(fileEventsForFile.length).toBe(2);
        expect(fileEventsForFile[0].pathName).toBe('deep.txt');

        const limited = await mount.history.list(folderId, { limit: 1 });
        expect(limited).toHaveLength(1);
    });

    test('deleting a path cascades its file_events rows', async () => {
        const fileId = await mount.touchFile(rootId, 'cascade-test.txt', 'text/plain');
        await mount.history.record({
            pathId: fileId,
            eventType: 'created',
            actor: { id: 'u3', email: 'u3@test' },
        });

        const before = await mount.history.list(fileId);
        expect(before).toHaveLength(1);

        await mount.trashPath(fileId);
        await mount.permanentlyDeleteFromTrash(fileId);

        // Raw select proves the FK cascade actually deleted the file_events rows —
        // list() would also return [] via the CTE even if the rows survived (path is gone).
        const surviving = metaDb.db.select().from(fileEvents).where(eq(fileEvents.pathId, fileId)).all();
        expect(surviving).toHaveLength(0);

        const after = await mount.history.list(fileId);
        expect(after).toHaveLength(0);
    });

    test('record dedupes identical events within dedupeWindowMs', async () => {
        const fileId = await mount.touchFile(rootId, 'dedupe-test.txt', 'text/plain');

        const input = {
            pathId: fileId,
            eventType: 'edited' as const,
            actor: { id: 'u4', email: 'u4@test' },
        };
        const opts = { dedupeWindowMs: 30_000 };

        await mount.history.record(input, opts);
        await mount.history.record(input, opts);

        const events = await mount.history.list(fileId);
        expect(events).toHaveLength(1);
    });

    test('record does not dedupe when details differ', async () => {
        const fileId = await mount.touchFile(rootId, 'dedupe-details-test.txt', 'text/plain');

        const opts = { dedupeWindowMs: 30_000 };
        await mount.history.record(
            {
                pathId: fileId,
                eventType: 'renamed',
                actor: { id: 'u5', email: 'u5@test' },
                details: { oldName: 'a.txt', newName: 'b.txt' },
            },
            opts,
        );
        await mount.history.record(
            {
                pathId: fileId,
                eventType: 'renamed',
                actor: { id: 'u5', email: 'u5@test' },
                details: { oldName: 'b.txt', newName: 'c.txt' },
            },
            opts,
        );

        const events = await mount.history.list(fileId);
        expect(events).toHaveLength(2);
    });

    test('prune trims per-path rows beyond 500', async () => {
        const fileId = await mount.touchFile(rootId, 'prune-test.txt', 'text/plain');

        // Seed 502 events via raw insert; prune should trim back to 500
        for (let i = 0; i < 502; i++) {
            metaDb.db
                .insert(fileEvents)
                .values({
                    id: randomUUID(),
                    pathId: fileId,
                    eventType: 'edited',
                    actorUserId: 'u6',
                    actorEmail: 'u6@test',
                    details: null,
                    createdAt: new Date(),
                })
                .run();
        }

        const beforePrune = await mount.history.list(fileId, { limit: 600 });
        expect(beforePrune.length).toBe(502);

        mount.history.prune();

        const afterPrune = await mount.history.list(fileId, { limit: 600 });
        expect(afterPrune.length).toBe(500);
    });
});

describe('FileHistory old-row prune', () => {
    let mount: Mount;
    let rootId: string;
    let metaDb: ManagedDatabase<SchemaType>;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-prune-old', 'local-key');
        const { getter, captured } = createGetLocalDatabase(TEST_DIR);
        mount = new Mount(OWNER_ID, TEST_DIR, config, getter);
        await mount.init();
        rootId = (await mount.getRootFolder())!.id;
        metaDb = captured.get('mounts/test-prune-old/metadata.db')!;
    });

    test('prune drops rows older than 90 days', async () => {
        const fileId = await mount.touchFile(rootId, 'old-event.txt', 'text/plain');

        await mount.history.record({
            pathId: fileId,
            eventType: 'created',
            actor: { id: 'u7', email: 'u7@test' },
        });

        // Insert a row backdated 91 days to verify the 90-day prune without sleeping
        const oldDate = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
        metaDb.db
            .insert(fileEvents)
            .values({
                id: randomUUID(),
                pathId: fileId,
                eventType: 'edited',
                actorUserId: 'u7',
                actorEmail: 'u7@test',
                details: null,
                createdAt: oldDate,
            })
            .run();

        const beforePrune = await mount.history.list(fileId, { limit: 600 });
        expect(beforePrune.length).toBe(2);

        mount.history.prune();

        const afterPrune = await mount.history.list(fileId, { limit: 600 });
        expect(afterPrune.length).toBe(1);
        expect(afterPrune[0].eventType).toBe('created');
    });
});

describe('Drive history recording', () => {
    let ctx: TestContext;
    let aliceToken: string;
    let aliceOwnerId: string;
    let aliceMountId: string;
    let aliceRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        aliceToken = ctx.alice.user.sessionToken;
        aliceOwnerId = ctx.alice.user.id;

        const mountsRes = await authedRequest(aliceToken, `/drive/${aliceOwnerId}/mounts`);
        const mountsData = (await mountsRes.json()) as { id: string }[];
        aliceMountId = mountsData[0].id;

        const rootRes = await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${aliceMountId}/root`);
        const root = (await rootRes.json()) as { id: string };
        aliceRootId = root.id;
    });

    test('create folder records created', async () => {
        const folder = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'HistFolder',
        });
        const res = await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${aliceMountId}/path/${folder.id}/history`);
        expect(res.status).toBe(200);
        const events = (await res.json()) as FileEvent[];
        expect(events.some((e) => e.eventType === 'created')).toBe(true);
        const created = events.find((e) => e.eventType === 'created')!;
        expect(created.actorEmail).toBe('alice@test.eigen.is');
    });

    test('rename records renamed with old/new names', async () => {
        const folder = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'RenameMe',
        });
        await drivePut(aliceToken, aliceOwnerId, aliceMountId, `path/${folder.id}/rename`, { newName: 'Renamed' });
        const res = await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${aliceMountId}/path/${folder.id}/history`);
        const events = (await res.json()) as FileEvent[];
        const renamed = events.find((e) => e.eventType === 'renamed');
        expect(renamed).toBeDefined();
        expect(renamed!.details).toEqual({ oldName: 'RenameMe', newName: 'Renamed' });
    });

    test('upload records uploaded with size', async () => {
        const folder = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'UploadFolder',
        });
        const content = 'hello world';
        const file = new File([content], 'test.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(aliceToken, aliceOwnerId, aliceMountId, folder.id, file);
        const res = await authedRequest(
            aliceToken,
            `/drive/${aliceOwnerId}/${aliceMountId}/path/${uploaded.id}/history`,
        );
        const events = (await res.json()) as FileEvent[];
        const uploadedEvent = events.find((e) => e.eventType === 'uploaded');
        expect(uploadedEvent).toBeDefined();
        expect((uploadedEvent!.details as { size: number }).size).toBeGreaterThan(0);
    });

    test('move records moved with parent ids', async () => {
        const folder1 = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'MoveSource',
        });
        const folder2 = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'MoveDest',
        });
        const file = new File(['content'], 'moveme.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(aliceToken, aliceOwnerId, aliceMountId, folder1.id, file);

        await drivePut(aliceToken, aliceOwnerId, aliceMountId, `path/${uploaded.id}/move`, {
            targetParentId: folder2.id,
        });
        const res = await authedRequest(
            aliceToken,
            `/drive/${aliceOwnerId}/${aliceMountId}/path/${uploaded.id}/history`,
        );
        const events = (await res.json()) as FileEvent[];
        const moved = events.find((e) => e.eventType === 'moved');
        expect(moved).toBeDefined();
        expect((moved!.details as { oldParentId: string; newParentId: string }).oldParentId).toBe(folder1.id);
        expect((moved!.details as { oldParentId: string; newParentId: string }).newParentId).toBe(folder2.id);
    });

    test('acl PUT records acl-changed with added emails', async () => {
        const folder = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'ShareMe',
        });
        await drivePut(aliceToken, aliceOwnerId, aliceMountId, `path/${folder.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
        });
        const res = await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${aliceMountId}/path/${folder.id}/history`);
        const events = (await res.json()) as FileEvent[];
        const aclChanged = events.find((e) => e.eventType === 'acl-changed');
        expect(aclChanged).toBeDefined();
        expect((aclChanged!.details as { added: string[]; removed: string[] }).added).toContain(ctx.bob.user.email);
    });

    test('trash records trashed; restore records restored', async () => {
        const file = new File(['content'], 'trashme.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(aliceToken, aliceOwnerId, aliceMountId, aliceRootId, file);

        await driveDelete(aliceToken, aliceOwnerId, aliceMountId, `path/${uploaded.id}`);

        const restoreRes = await authedRequest(
            aliceToken,
            `/drive/${aliceOwnerId}/${aliceMountId}/trash/${uploaded.id}/restore`,
            { method: 'POST' },
        );
        expect(restoreRes.status).toBe(200);

        const res = await authedRequest(
            aliceToken,
            `/drive/${aliceOwnerId}/${aliceMountId}/path/${uploaded.id}/history`,
        );
        const events = (await res.json()) as FileEvent[];
        expect(events.some((e) => e.eventType === 'trashed')).toBe(true);
        expect(events.some((e) => e.eventType === 'restored')).toBe(true);
    });

    test('copy records copied on root and descendants', async () => {
        const home = await getHome(aliceOwnerId);

        const folder = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'CopySource',
        });
        const subFile = new File(['content'], 'subfile.txt', { type: 'text/plain' });
        const sourceChild = await driveUpload(aliceToken, aliceOwnerId, aliceMountId, folder.id, subFile);

        const destFolder = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'CopyDest',
        });

        const actor = await getUserById(ctx.alice.user.id);
        expect(actor).not.toBeNull();
        const copied = await home.drive.copyPath(aliceMountId, folder.id, destFolder.id, 'CopiedFolder', actor!);

        // Root folder copy records 'copied'
        const res = await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${aliceMountId}/path/${copied.id}/history`);
        const events = (await res.json()) as FileEvent[];
        expect(events.some((e) => e.eventType === 'copied')).toBe(true);

        // Descendant in the copied folder also records 'copied' with sourcePathId = the source child's id
        const copiedChildren = await driveGet<{ id: string; name: string }[]>(
            aliceToken,
            aliceOwnerId,
            aliceMountId,
            `folder/${copied.id}`,
        );
        const copiedChild = copiedChildren.find((c) => c.name === 'subfile.txt');
        expect(copiedChild).toBeDefined();

        const childHistoryRes = await authedRequest(
            aliceToken,
            `/drive/${aliceOwnerId}/${aliceMountId}/path/${copiedChild!.id}/history`,
        );
        const childEvents = (await childHistoryRes.json()) as FileEvent[];
        const childCopied = childEvents.filter((e) => e.eventType === 'copied');
        expect(childCopied).toHaveLength(1);
        expect((childCopied[0].details as { sourcePathId: string }).sourcePathId).toBe(sourceChild.id);
    });

    test('folder history endpoint includes descendant events', async () => {
        const folder = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'ParentFolder',
        });
        const file = new File(['content'], 'child.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(aliceToken, aliceOwnerId, aliceMountId, folder.id, file);

        await drivePut(aliceToken, aliceOwnerId, aliceMountId, `path/${uploaded.id}/rename`, {
            newName: 'renamed.txt',
        });

        const res = await authedRequest(aliceToken, `/drive/${aliceOwnerId}/${aliceMountId}/path/${folder.id}/history`);
        const events = (await res.json()) as FileEvent[];
        expect(events.some((e) => e.pathId === uploaded.id)).toBe(true);
    });

    test('403 for bob without access', async () => {
        const folder = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'NoAccessFolder',
        });
        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${aliceOwnerId}/${aliceMountId}/path/${folder.id}/history`,
        );
        expect(res.status).toBe(403);
    });

    test('200 with read share', async () => {
        const folder = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'SharedForHistory',
        });
        await drivePut(aliceToken, aliceOwnerId, aliceMountId, `path/${folder.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
        });
        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${aliceOwnerId}/${aliceMountId}/path/${folder.id}/history`,
        );
        expect(res.status).toBe(200);
    });

    test('version-restored after save+restore', async () => {
        const home = await getHome(aliceOwnerId);

        const alice = await getUserById(ctx.alice.user.id);
        expect(alice).not.toBeNull();
        const newPath = await home.drive.create(aliceMountId, aliceRootId, 'VersionTestDoc', 'doc', alice!);
        const version = await home.drive.saveVersion(aliceMountId, newPath.id);
        await home.drive.restoreContainer(aliceMountId, newPath.id, version.name, alice!);

        const res = await authedRequest(
            aliceToken,
            `/drive/${aliceOwnerId}/${aliceMountId}/path/${newPath.id}/history`,
        );
        const events = (await res.json()) as FileEvent[];
        const versionRestored = events.find((e) => e.eventType === 'version-restored');
        expect(versionRestored).toBeDefined();
        expect((versionRestored!.details as { versionName: string }).versionName).toBe(version.name);
    });

    test('recording a file event broadcasts drive:file-history-updated to owner + shared members', async () => {
        const folder = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'BroadcastMe',
        });
        // Share with bob so he is an effective member of the file-history fan-out.
        await drivePut(aliceToken, aliceOwnerId, aliceMountId, `path/${folder.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
        });

        const aliceSse = collectSSE(aliceOwnerId);
        const bobSse = collectSSE(ctx.bob.user.id);
        // collectSSE subscribes asynchronously — let both homes attach before mutating.
        await new Promise((resolve) => setTimeout(resolve, 50));

        await drivePut(aliceToken, aliceOwnerId, aliceMountId, `path/${folder.id}/rename`, { newName: 'Broadcasted' });

        const isHistoryEvent = (e: SSEvent): boolean => e.type === SSEventType.DRIVE_FILE_HISTORY_UPDATED;
        await waitFor(() => aliceSse.events.some(isHistoryEvent) && bobSse.events.some(isHistoryEvent));

        aliceSse.stop();
        bobSse.stop();
        expect(aliceSse.events.some(isHistoryEvent)).toBe(true);
        expect(bobSse.events.some(isHistoryEvent)).toBe(true);
    });

    test('moving an item broadcasts drive:file-history-updated to owner + destination members', async () => {
        // Move records history inline (no recordFileEvent) — it must still fan the broadcast out.
        const src = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'MoveBroadcastSrc',
        });
        const dest = await drivePost(aliceToken, aliceOwnerId, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'MoveBroadcastDest',
        });
        // Share the destination with bob so he is an effective member of the moved item's new chain.
        await drivePut(aliceToken, aliceOwnerId, aliceMountId, `path/${dest.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
        });
        const file = new File(['content'], 'movebroadcast.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(aliceToken, aliceOwnerId, aliceMountId, src.id, file);

        const aliceSse = collectSSE(aliceOwnerId);
        const bobSse = collectSSE(ctx.bob.user.id);
        await new Promise((resolve) => setTimeout(resolve, 50));

        await drivePut(aliceToken, aliceOwnerId, aliceMountId, `path/${uploaded.id}/move`, {
            targetParentId: dest.id,
        });

        const isHistoryEvent = (e: SSEvent): boolean => e.type === SSEventType.DRIVE_FILE_HISTORY_UPDATED;
        await waitFor(() => aliceSse.events.some(isHistoryEvent) && bobSse.events.some(isHistoryEvent));

        aliceSse.stop();
        bobSse.stop();
        expect(aliceSse.events.some(isHistoryEvent)).toBe(true);
        expect(bobSse.events.some(isHistoryEvent)).toBe(true);
    });
});

// The file-event notification now carries the whole event: title = action line, body = primary
// content, details = { secondary, cardId, chatName, pathType } — composed through describeFileEvent,
// the same phrasing the activity panel renders with.
describe('file-event notifications carry the event details', () => {
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

    async function notificationsFor(userId: string): Promise<Notification[]> {
        const home = await getHome(userId);
        return home.notifications.list();
    }

    function fileEventTag(pathId: string): string {
        return `file-event:${aliceOwnerId}:${mountId}:${pathId}`;
    }

    function postSticky(pathId: string, body: Record<string, unknown>): Promise<Response> {
        return authedRequest(aliceToken, `/drive/${aliceOwnerId}/${mountId}/path/${pathId}/history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    test('a sticky-added event reaches the watcher with body + card details, and coalesces to the latest', async () => {
        const board = await drivePost<DrivePath>(
            aliceToken,
            aliceOwnerId,
            mountId,
            `folder/${rootId}/create/stickies`,
            {
                fileName: 'DetailBoard',
            },
        );
        await drivePut(aliceToken, aliceOwnerId, mountId, `path/${board.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
        });
        await authedRequest(bobToken, `/drive/${aliceOwnerId}/${mountId}/path/${board.id}/watch`, { method: 'POST' });

        const added = await postSticky(board.id, {
            eventType: 'sticky-added',
            details: { card: 'Hello', toColumn: 'To Do', cardId: 'c1' },
        });
        expect(added.status).toBe(200);

        const row = (await notificationsFor(ctx.bob.user.id)).find((n) => n.tag === fileEventTag(board.id));
        expect(row).toBeDefined();
        expect(row!.title).toBe('Alice Test added a card to "DetailBoard"');
        expect(row!.body).toBe('Hello');
        expect(row!.details).toEqual({ cardId: 'c1', secondary: 'in To Do', pathType: 'stickies' });

        // A second, different event on the same board upserts the ONE tagged row to the latest change
        const moved = await postSticky(board.id, {
            eventType: 'sticky-moved',
            details: { card: 'Hello', toColumn: 'Done', cardId: 'c1' },
        });
        expect(moved.status).toBe(200);

        const rows = (await notificationsFor(ctx.bob.user.id)).filter((n) => n.tag === fileEventTag(board.id));
        expect(rows).toHaveLength(1);
        expect(rows[0].title).toBe('Alice Test moved a card in "DetailBoard"');
        expect(rows[0].body).toBe('Hello → Done');
        expect(rows[0].details).toEqual({ cardId: 'c1', pathType: 'stickies' });
    });
});
