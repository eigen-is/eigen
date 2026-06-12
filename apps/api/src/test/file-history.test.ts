import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../lib/core';
import { createDefaultMountConfig, Mount } from '../lib/mount/mount';
import { fileEvents } from '../lib/mount/schema';

const TEST_DIR = join(import.meta.dir, `../../../../data-test/test-file-history-${Date.now()}`);
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

    test('prune trims per-path rows beyond 500 and drops rows older than 90 days', async () => {
        const fileId = await mount.touchFile(rootId, 'prune-test.txt', 'text/plain');

        // Insert 502 events; prune should trim back to 500
        for (let i = 0; i < 502; i++) {
            await mount.history.record({
                pathId: fileId,
                eventType: 'edited',
                actor: { id: 'u6', email: 'u6@test' },
            });
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
