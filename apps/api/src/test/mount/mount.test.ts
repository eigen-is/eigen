import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { eq, type SQL, sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../../lib/core';
import { getUniqueFileName } from '../../lib/drive/naming';
import {
    CONTENT_REINDEX_CAP_SECONDS,
    type ContentExtractor,
    ContentReindexQueue,
} from '../../lib/mount/content-reindex-queue';
import { buildStorageKey, createDefaultMountConfig } from '../../lib/mount/helpers';
import { Mount } from '../../lib/mount/mount';
import { paths } from '../../lib/mount/schema';
import { LocalStorage } from '../../lib/storage/local-storage';
import { DEFAULT_RETENTION } from '../../lib/versioning/retention';
import { parseSnapshotTimestamp } from '../../lib/versioning/timestamp';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-mount-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

function createGetLocalDatabase(baseDir: string) {
    return async <S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string,
    ): Promise<ManagedDatabase<S>> => {
        const fullPath = join(baseDir, relativePath);
        const db = new ManagedDatabase(config, fullPath);
        await db.open(0);
        return db;
    };
}

beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

describe('buildStorageKey', () => {
    test('appends extension when valid', () => {
        expect(buildStorageKey('abc-123', 'report.pdf')).toBe('abc-123.pdf');
    });

    test('lowercases extension', () => {
        expect(buildStorageKey('abc-123', 'photo.JPG')).toBe('abc-123.jpg');
    });

    test('returns id for no extension', () => {
        expect(buildStorageKey('abc-123', 'README')).toBe('abc-123');
    });

    test('returns id for dotfile with no extension', () => {
        expect(buildStorageKey('abc-123', '.gitignore')).toBe('abc-123');
    });

    test('returns id for extension longer than 12 chars', () => {
        expect(buildStorageKey('abc-123', 'file.verylongextension')).toBe('abc-123');
    });

    test('handles multiple dots — uses last extension', () => {
        expect(buildStorageKey('abc-123', 'archive.tar.gz')).toBe('abc-123.gz');
    });

    test('handles empty name', () => {
        expect(buildStorageKey('abc-123', '')).toBe('abc-123');
    });
});

describe('downloadToTemp', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-download-to-temp', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        rootId = (await mount.getRootFolder())!.id;
    });

    test('copies a stored file to a temp path, then cleanupTemp removes it', async () => {
        const data = Buffer.from('snapshot-bytes');
        const fileId = await mount.createFile(rootId, 'snap.db', 'application/octet-stream', data.length, data);
        const tempId = randomUUID();
        const tempPath = await mount.downloadToTemp(fileId, tempId);
        expect(readFileSync(tempPath).toString()).toBe('snapshot-bytes');
        await mount.cleanupTemp(tempId);
        expect(existsSync(tempPath)).toBe(false);
    });

    test('works on backends without a local path (S3-style: no getPath)', async () => {
        // The version-restore read path must not depend on storage.getPath — that
        // was the original S3 bug. downloadToTemp goes through storage.read, which
        // every backend implements.
        const data = Buffer.from('snapshot-bytes-no-getpath');
        const fileId = await mount.createFile(rootId, 'snap2.db', 'application/octet-stream', data.length, data);

        const storage = (mount as unknown as { storage: { getPath?: (key: string) => string } }).storage;
        const originalGetPath = storage.getPath;
        storage.getPath = undefined;
        try {
            const tempId = randomUUID();
            const tempPath = await mount.downloadToTemp(fileId, tempId);
            expect(readFileSync(tempPath).toString()).toBe('snapshot-bytes-no-getpath');
            await mount.cleanupTemp(tempId);
        } finally {
            storage.getPath = originalGetPath;
        }
    });

    // An open doc's live working copy is the temp path keyed by its data.db pathId, so a
    // tempId colliding with an open document DB would truncate live state. Safe today
    // (callers pass fresh randomUUIDs) — this pins the invariant.
    test('refuses a tempId whose document DB is open', async () => {
        const guardSchema = { items: sqliteTable('items', { id: integer('id').primaryKey() }) };
        const guardConfig: DatabaseConfig<typeof guardSchema> = {
            name: 'download-guard-test',
            currentVersion: 1,
            schema: guardSchema,
            migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)') }],
        };
        const containerId = await mount.createFolder(rootId, 'OpenDoc', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
        await mount.createDatabase(guardConfig, dataDbId);
        await expect(mount.downloadToTemp(dataDbId, dataDbId)).rejects.toThrow('live working copy');
        await mount.closeDatabase(dataDbId);
    });
});

describe('snapshotContainerDataDb concurrency', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-snapshot-concurrency', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        rootId = (await mount.getRootFolder())!.id;
    });

    test('concurrent snapshots serialize: one versions folder, no clobbered files', async () => {
        const container = await mount.createFolder(rootId, 'snap-container');
        const data = Buffer.from('container-data-db-bytes');
        await mount.createFile(container, 'data.db', 'application/octet-stream', data.length, data);

        // Without the container lock these race on createFolder('versions') and the
        // timestamped copy, producing duplicate 'versions' folders or a duplicate-name
        // insert. snapshotContainerDataDb self-locks, so they serialize cleanly.
        const results = await Promise.all(
            Array.from({ length: 5 }, () => mount.snapshotContainerDataDb(container, DEFAULT_RETENTION)),
        );

        const children = await mount.listFolder(container);
        expect(children.filter((c) => c.name === 'versions')).toHaveLength(1);

        const versionsId = children.find((c) => c.name === 'versions')!.id;
        const snaps = await mount.listFolder(versionsId);
        expect(snaps.length).toBeGreaterThanOrEqual(1);
        // Everything left in versions/ is a real, parseable snapshot — no garbage.
        for (const s of snaps) expect(parseSnapshotTimestamp(s.name)).not.toBeNull();
        // Every call returned a usable snapshot path.
        for (const r of results) expect(parseSnapshotTimestamp(r.name)).not.toBeNull();
    });
});

describe('replaceContainerDataDb', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-replace-datadb', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        rootId = (await mount.getRootFolder())!.id;
    });

    test('recreates data.db even when it is missing (crash-recovery self-heal)', async () => {
        const container = await mount.createFolder(rootId, 'replace-container');
        await mount.createFile(container, 'data.db', 'application/x-sqlite3', 3, Buffer.from('old'));
        const sourcePath = join(TEST_DIR, 'replace-source.db');
        await Bun.write(sourcePath, 'restored-bytes');

        // Normal path: data.db present → replaced with the source content.
        await mount.replaceContainerDataDb(container, sourcePath);
        let dataDb = await mount.getChildByName(container, 'data.db');
        expect(dataDb).not.toBeNull();
        expect(await (await mount.readFile(dataDb!.id))!.text()).toBe('restored-bytes');

        // Simulate a restore that crashed after deleting data.db but before recreating it.
        await mount.deletePath(dataDb!.id);
        expect(await mount.getChildByName(container, 'data.db')).toBeNull();

        // Re-running restore must self-heal (recreate data.db), not throw a 404.
        await mount.replaceContainerDataDb(container, sourcePath);
        dataDb = await mount.getChildByName(container, 'data.db');
        expect(dataDb).not.toBeNull();
        expect(dataDb!.mimeType).toBe('application/x-sqlite3');
        expect(await (await mount.readFile(dataDb!.id))!.text()).toBe('restored-bytes');
    });
});

describe('Mount (local-key storage)', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-local-key', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const root = await mount.getRootFolder();
        expect(root).not.toBeNull();
        rootId = root!.id;
    });

    test('root folder is created on init', async () => {
        const root = await mount.getRootFolder();
        expect(root).not.toBeNull();
        expect(root!.name).toBe('Drive');
        expect(root!.type).toBe('folder');
        expect(root!.parentId).toBeNull();
    });

    test('create and list folder', async () => {
        const folderId = await mount.createFolder(rootId, 'Documents');
        const folder = await mount.getPath(folderId);
        expect(folder).not.toBeNull();
        expect(folder!.name).toBe('Documents');
        expect(folder!.type).toBe('folder');

        const children = await mount.listFolder(rootId);
        expect(children.some((c) => c.id === folderId)).toBe(true);
    });

    test('create file stores data', async () => {
        const data = Buffer.from('file content');
        const fileId = await mount.createFile(rootId, 'test.txt', 'text/plain', data.length, data);
        const file = await mount.getPath(fileId);
        expect(file).not.toBeNull();
        expect(file!.name).toBe('test.txt');
        expect(file!.type).toBe('file');
        expect(file!.size).toBe(12);

        const content = await mount.readFile(fileId);
        expect(content).not.toBeNull();
        expect(await content!.text()).toBe('file content');
    });

    test('duplicate name throws 409', async () => {
        await mount.createFolder(rootId, 'UniqueFolder');
        expect(mount.createFolder(rootId, 'UniqueFolder')).rejects.toThrow();
    });

    test('case-insensitive duplicate name throws', async () => {
        await mount.createFolder(rootId, 'CaseSensitive');
        expect(mount.createFolder(rootId, 'casesensitive')).rejects.toThrow();
    });

    // Id-keyed backends keep SQLite's ASCII-only fold: non-ASCII case pairs are distinct
    // files (unique storage keys, no disk aliasing). Only path-based mounts fold stricter.
    test('non-ASCII case pair is allowed on id-keyed storage', async () => {
        const folderId = await mount.createFolder(rootId, 'UnicodePair');
        await mount.createFile(folderId, 'É.txt', 'text/plain', 1, Buffer.from('a'));
        const secondId = await mount.createFile(folderId, 'é.txt', 'text/plain', 1, Buffer.from('b'));
        expect((await mount.getPath(secondId))!.name).toBe('é.txt');
    });

    test('rename path', async () => {
        const folderId = await mount.createFolder(rootId, 'OldName');
        await mount.updatePath(folderId, { name: 'NewName' });
        const folder = await mount.getPath(folderId);
        expect(folder!.name).toBe('NewName');
    });

    test('delete file', async () => {
        const data = Buffer.from('to delete');
        const fileId = await mount.createFile(rootId, 'deleteme.txt', 'text/plain', data.length, data);
        await mount.deletePath(fileId);
        const file = await mount.getPath(fileId);
        expect(file).toBeNull();
    });

    test('delete folder deletes children', async () => {
        const folderId = await mount.createFolder(rootId, 'ParentToDelete');
        const childId = await mount.createFolder(folderId, 'ChildFolder');
        const data = Buffer.from('child file');
        const fileId = await mount.createFile(childId, 'child.txt', 'text/plain', data.length, data);

        await mount.deletePath(folderId);
        expect(await mount.getPath(folderId)).toBeNull();
        expect(await mount.getPath(childId)).toBeNull();
        expect(await mount.getPath(fileId)).toBeNull();
    });

    test('breadcrumb returns full path', async () => {
        const folderId = await mount.createFolder(rootId, 'BreadcrumbParent');
        const childId = await mount.createFolder(folderId, 'BreadcrumbChild');
        const crumbs = await mount.getBreadcrumb(childId);
        expect(crumbs.length).toBe(3);
        expect(crumbs[0].name).toBe('Drive');
        expect(crumbs[1].name).toBe('BreadcrumbParent');
        expect(crumbs[2].name).toBe('BreadcrumbChild');
    });

    test('writeFile updates size', async () => {
        const fileId = await mount.createFile(rootId, 'sized.txt', 'text/plain', 0, undefined);
        await mount.writeFile(fileId, Buffer.from('updated content'));
        const file = await mount.getPath(fileId);
        expect(file!.size).toBe(15);
    });

    test('getChildByName is case-insensitive', async () => {
        const folderId = await mount.createFolder(rootId, 'FindMe');
        const found = await mount.getChildByName(rootId, 'findme');
        expect(found).not.toBeNull();
        expect(found!.id).toBe(folderId);
    });

    test('touchFile creates empty file', async () => {
        const fileId = await mount.touchFile(rootId, 'empty.txt', 'text/plain');
        const file = await mount.getPath(fileId);
        expect(file).not.toBeNull();
        expect(file!.size).toBe(0);
    });

    test('getTotalSize aggregates file sizes', async () => {
        const size = await mount.getTotalSize();
        expect(size).toBeGreaterThan(0);
    });

    test('getFileCount counts files', async () => {
        const count = await mount.getFileCount();
        expect(count).toBeGreaterThan(0);
    });
});

describe('Mount (local path-based storage)', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-local', 'local');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const root = await mount.getRootFolder();
        expect(root).not.toBeNull();
        rootId = root!.id;
    });

    test('create folder creates physical directory', async () => {
        const folderId = await mount.createFolder(rootId, 'PhysicalFolder');
        expect(existsSync(join(mount.dataDir, 'PhysicalFolder'))).toBe(true);

        const folder = await mount.getPath(folderId);
        expect(folder!.name).toBe('PhysicalFolder');
    });

    test('create nested folder creates physical subdirectory', async () => {
        const parentId = await mount.createFolder(rootId, 'Level1');
        await mount.createFolder(parentId, 'Level2');
        expect(existsSync(join(mount.dataDir, 'Level1', 'Level2'))).toBe(true);
    });

    test('create file stores data at correct path', async () => {
        const folderId = await mount.createFolder(rootId, 'FileFolder');
        const data = Buffer.from('path-based content');
        const fileId = await mount.createFile(folderId, 'doc.txt', 'text/plain', data.length, data);
        expect(existsSync(join(mount.dataDir, 'FileFolder', 'doc.txt'))).toBe(true);

        const content = await mount.readFile(fileId);
        expect(content).not.toBeNull();
        expect(await content!.text()).toBe('path-based content');
    });

    test('rename folder renames physical directory', async () => {
        const folderId = await mount.createFolder(rootId, 'RenameMe');
        await mount.createFile(folderId, 'inside.txt', 'text/plain', 5, Buffer.from('hello'));
        expect(existsSync(join(mount.dataDir, 'RenameMe'))).toBe(true);

        await mount.updatePath(folderId, { name: 'Renamed' });
        expect(existsSync(join(mount.dataDir, 'RenameMe'))).toBe(false);
        expect(existsSync(join(mount.dataDir, 'Renamed'))).toBe(true);
        expect(existsSync(join(mount.dataDir, 'Renamed', 'inside.txt'))).toBe(true);
    });

    test('move file between folders updates physical location', async () => {
        const srcFolder = await mount.createFolder(rootId, 'Source');
        const dstFolder = await mount.createFolder(rootId, 'Destination');
        const data = Buffer.from('movable');
        const fileId = await mount.createFile(srcFolder, 'move.txt', 'text/plain', data.length, data);
        expect(existsSync(join(mount.dataDir, 'Source', 'move.txt'))).toBe(true);

        await mount.updatePath(fileId, { parentId: dstFolder });
        expect(existsSync(join(mount.dataDir, 'Source', 'move.txt'))).toBe(false);
        expect(existsSync(join(mount.dataDir, 'Destination', 'move.txt'))).toBe(true);
    });

    test('delete folder removes physical directory', async () => {
        const folderId = await mount.createFolder(rootId, 'DeletePhysical');
        await mount.createFile(folderId, 'file.txt', 'text/plain', 3, Buffer.from('abc'));
        expect(existsSync(join(mount.dataDir, 'DeletePhysical'))).toBe(true);

        await mount.deletePath(folderId);
        expect(existsSync(join(mount.dataDir, 'DeletePhysical'))).toBe(false);
        expect(await mount.getPath(folderId)).toBeNull();
    });

    test('delete folder removes descendant DB entries', async () => {
        const folderId = await mount.createFolder(rootId, 'DeepDelete');
        const subId = await mount.createFolder(folderId, 'Sub');
        const fileId = await mount.createFile(subId, 'deep.txt', 'text/plain', 4, Buffer.from('deep'));

        await mount.deletePath(folderId);
        expect(await mount.getPath(subId)).toBeNull();
        expect(await mount.getPath(fileId)).toBeNull();
    });

    test('duplicate name in same folder throws', async () => {
        await mount.createFolder(rootId, 'Unique');
        expect(mount.createFolder(rootId, 'Unique')).rejects.toThrow();
    });

    test('same name in different folders is allowed', async () => {
        const a = await mount.createFolder(rootId, 'FolderA');
        const b = await mount.createFolder(rootId, 'FolderB');
        await mount.createFile(a, 'same.txt', 'text/plain', 1, Buffer.from('a'));
        await mount.createFile(b, 'same.txt', 'text/plain', 1, Buffer.from('b'));

        const fileA = await mount.getChildByName(a, 'same.txt');
        const fileB = await mount.getChildByName(b, 'same.txt');
        expect(fileA).not.toBeNull();
        expect(fileB).not.toBeNull();
        expect(fileA!.id).not.toBe(fileB!.id);
    });

    // SQLite's LOWER() is ASCII-only, but names ARE disk paths here and case-insensitive
    // filesystems (APFS, Windows) fold non-ASCII case pairs to one file — a silent clobber.
    test('non-ASCII case pair in same folder throws 409', async () => {
        const folderId = await mount.createFolder(rootId, 'UnicodeCase');
        await mount.createFile(folderId, 'Ärger.txt', 'text/plain', 1, Buffer.from('a'));
        expect(mount.createFile(folderId, 'ärger.txt', 'text/plain', 1, Buffer.from('b'))).rejects.toThrow(
            'already exists',
        );
    });

    test('getChildByName finds a non-ASCII cross-case sibling', async () => {
        const folderId = await mount.createFolder(rootId, 'UnicodeLookup');
        const fileId = await mount.createFile(folderId, 'Übung.txt', 'text/plain', 1, Buffer.from('u'));
        const found = await mount.getChildByName(folderId, 'übung.txt');
        expect(found).not.toBeNull();
        expect(found!.id).toBe(fileId);
    });
});

describe('Name validation', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-validate', 'local');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const root = await mount.getRootFolder();
        rootId = root!.id;
    });

    test('rejects .. as folder name', async () => {
        expect(mount.createFolder(rootId, '..')).rejects.toThrow('Invalid file or folder name');
    });

    test('rejects . as folder name', async () => {
        expect(mount.createFolder(rootId, '.')).rejects.toThrow('Invalid file or folder name');
    });

    test('rejects empty name', async () => {
        expect(mount.createFolder(rootId, '')).rejects.toThrow('Invalid file or folder name');
    });

    test('rejects name with slash', async () => {
        expect(mount.createFolder(rootId, 'a/b')).rejects.toThrow('Invalid file or folder name');
    });

    test('rejects name with backslash', async () => {
        expect(mount.createFolder(rootId, 'a\\b')).rejects.toThrow('Invalid file or folder name');
    });

    test('rejects name with null byte', async () => {
        expect(mount.createFolder(rootId, 'a\0b')).rejects.toThrow('Invalid file or folder name');
    });

    test('rejects name with control character', async () => {
        expect(mount.createFolder(rootId, 'a\x01b')).rejects.toThrow('Invalid file or folder name');
    });

    test('rejects .. as file name', async () => {
        expect(mount.createFile(rootId, '..', 'text/plain', 0, undefined)).rejects.toThrow(
            'Invalid file or folder name',
        );
    });

    test('rejects .. on rename', async () => {
        const id = await mount.createFolder(rootId, 'ValidName');
        expect(mount.updatePath(id, { name: '..' })).rejects.toThrow('Invalid file or folder name');
    });

    test('rejects .trash as folder name', async () => {
        expect(mount.createFolder(rootId, '.trash')).rejects.toThrow('reserved name');
    });

    test('rejects .trash case-insensitively', async () => {
        expect(mount.createFolder(rootId, '.TRASH')).rejects.toThrow('reserved name');
        expect(mount.createFolder(rootId, '.Trash')).rejects.toThrow('reserved name');
    });

    test('rejects .trash compatibility-character aliases', async () => {
        // U+017F LATIN SMALL LETTER LONG S: '.traſh' IS the '.trash' dir under APFS case folding,
        // but survives NFC + toLowerCase. NFKC maps ſ→s.
        expect(mount.createFolder(rootId, '.traſh')).rejects.toThrow('reserved name');
    });

    test('rejects .trash as file name', async () => {
        expect(mount.createFile(rootId, '.trash', 'text/plain', 0, undefined)).rejects.toThrow('reserved name');
    });

    test('rejects .trash on rename', async () => {
        const id = await mount.createFolder(rootId, 'NotTrash');
        expect(mount.updatePath(id, { name: '.trash' })).rejects.toThrow('reserved name');
    });

    // A legacy pre-guard row named .trash could otherwise be MOVED to the mount root,
    // where storage.rename would land it on the real trash dir (the audit's move vector).
    test('rejects moving a legacy .trash row to another parent', async () => {
        const subId = await mount.createFolder(rootId, 'LegacyHome');
        const folderId = await mount.createFolder(subId, 'PreGuard');
        // Simulate a pre-guard row faithfully: name + file column + physical dir all `.trash`.
        await mount.db.update(paths).set({ name: '.trash', file: '.trash' }).where(eq(paths.id, folderId));
        renameSync(join(mount.dataDir, 'LegacyHome', 'PreGuard'), join(mount.dataDir, 'LegacyHome', '.trash'));

        expect(mount.updatePath(folderId, { parentId: rootId })).rejects.toThrow('reserved name');
        // The real trash dir must still be the mount's own, not the user folder.
        expect(existsSync(join(mount.dataDir, 'LegacyHome', '.trash'))).toBe(true);
    });

    test('rejects name longer than 255 bytes', async () => {
        // Must be the 400 guard, not a raw fs ENAMETOOLONG 500.
        expect(mount.createFolder(rootId, 'a'.repeat(300))).rejects.toThrow(
            'File or folder name too long (max 255 bytes)',
        );
    });

    test('length cap counts bytes, not characters', async () => {
        // 130 chars but 260 UTF-8 bytes — over the ENAMETOOLONG byte limit.
        expect(mount.createFolder(rootId, 'ä'.repeat(130))).rejects.toThrow(
            'File or folder name too long (max 255 bytes)',
        );
    });

    test('allows a 255-byte name', async () => {
        const id = await mount.createFolder(rootId, 'b'.repeat(255));
        const folder = await mount.getPath(id);
        expect(folder!.name).toBe('b'.repeat(255));
    });

    test('allows dotfiles', async () => {
        const id = await mount.createFile(rootId, '.gitignore', 'text/plain', 0, undefined);
        const file = await mount.getPath(id);
        expect(file!.name).toBe('.gitignore');
    });

    test('allows names with dots', async () => {
        const id = await mount.createFile(rootId, 'archive.tar.gz', 'application/gzip', 0, undefined);
        const file = await mount.getPath(id);
        expect(file!.name).toBe('archive.tar.gz');
    });
});

describe('getUniqueFileName', () => {
    test('suffixes (2) when no numbered sibling exists', () => {
        const used = new Set(['other.txt']);
        expect(getUniqueFileName('photo.jpg', used)).toBe('photo (2).jpg');
    });

    test('increments number for simple collision', () => {
        const used = new Set(['photo.jpg', 'photo (2).jpg']);
        expect(getUniqueFileName('photo.jpg', used)).toBe('photo (3).jpg');
    });

    test('increments existing numbered file', () => {
        const used = new Set(['photo (3).jpg', 'photo (4).jpg']);
        expect(getUniqueFileName('photo (3).jpg', used)).toBe('photo (5).jpg');
    });

    test('handles file without extension', () => {
        const used = new Set(['readme', 'readme (2)']);
        expect(getUniqueFileName('readme', used)).toBe('readme (3)');
    });

    test('case-insensitive collision detection', () => {
        const used = new Set(['photo (2).jpg']);
        expect(getUniqueFileName('Photo.JPG', used)).toBe('Photo (3).JPG');
    });

    test('handles many collisions', () => {
        const used = new Set<string>();
        for (let i = 2; i <= 51; i++) used.add(`file (${i}).txt`);
        expect(getUniqueFileName('file.txt', used)).toBe('file (52).txt');
    });

    test('dotfile has no extension — suffix goes at the end', () => {
        const used = new Set(['.trash']);
        expect(getUniqueFileName('.trash', used)).toBe('.trash (2)');
    });
});

describe('Trash query filtering', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-trash-filter', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const root = await mount.getRootFolder();
        expect(root).not.toBeNull();
        rootId = root!.id;
    });

    test('listFolder excludes trashed items', async () => {
        const data = Buffer.from('trash-test');
        const fileId = await mount.createFile(rootId, 'trashed-file.txt', 'text/plain', data.length, data);

        // Verify it appears before trashing
        let children = await mount.listFolder(rootId);
        expect(children.some((c) => c.id === fileId)).toBe(true);

        // Simulate trashing via updatePath
        await mount.updatePath(fileId, { trashedAt: new Date() });

        // Should no longer appear in listFolder
        children = await mount.listFolder(rootId);
        expect(children.some((c) => c.id === fileId)).toBe(false);
    });

    test('getChildByName returns null for trashed items', async () => {
        const folderId = await mount.createFolder(rootId, 'TrashChildTest');

        // Verify it's findable before trashing
        let found = await mount.getChildByName(rootId, 'TrashChildTest');
        expect(found).not.toBeNull();
        expect(found!.id).toBe(folderId);

        // Simulate trashing
        await mount.updatePath(folderId, { trashedAt: new Date() });

        // Should no longer be found
        found = await mount.getChildByName(rootId, 'TrashChildTest');
        expect(found).toBeNull();
    });

    test('getPath still returns trashed items (unfiltered)', async () => {
        const data = Buffer.from('still-visible');
        const fileId = await mount.createFile(rootId, 'still-visible.txt', 'text/plain', data.length, data);

        await mount.updatePath(fileId, { trashedAt: new Date() });

        const file = await mount.getPath(fileId);
        expect(file).not.toBeNull();
        expect(file!.id).toBe(fileId);
        expect(file!.trashedAt).not.toBeNull();
    });

    test('getTotalSize still counts trashed items', async () => {
        const sizeBefore = await mount.getTotalSize();

        const data = Buffer.from('counted-even-when-trashed');
        const fileId = await mount.createFile(rootId, 'counted.txt', 'text/plain', data.length, data);

        const sizeAfterCreate = await mount.getTotalSize();
        expect(sizeAfterCreate).toBe(sizeBefore + data.length);

        // Trash the file
        await mount.updatePath(fileId, { trashedAt: new Date() });

        // Size should still include trashed file
        const sizeAfterTrash = await mount.getTotalSize();
        expect(sizeAfterTrash).toBe(sizeAfterCreate);
    });

    test('getActivePath throws 404 for trashed items', async () => {
        const data = Buffer.from('active-test');
        const fileId = await mount.createFile(rootId, 'active-test.txt', 'text/plain', data.length, data);

        await mount.updatePath(fileId, { trashedAt: new Date() });

        expect(mount.getActivePath(fileId)).rejects.toThrow('File is in trash');
    });

    test('getActivePath returns active items normally', async () => {
        const data = Buffer.from('active-ok');
        const fileId = await mount.createFile(rootId, 'active-ok.txt', 'text/plain', data.length, data);

        const result = await mount.getActivePath(fileId);
        expect(result).not.toBeNull();
        expect(result.id).toBe(fileId);
        expect(result.trashedAt).toBeNull();
    });

    test('getActivePath throws 404 for non-existent path', async () => {
        expect(mount.getActivePath('nonexistent-id')).rejects.toThrow('Path not found');
    });

    test('deletePath throws 400 when trying to delete root folder', async () => {
        expect(mount.deletePath(rootId)).rejects.toThrow('Cannot delete root folder');
    });

    test('assertUniqueName allows creating file with same name as trashed file', async () => {
        const data = Buffer.from('original');
        const fileId = await mount.createFile(rootId, 'reusable-name.txt', 'text/plain', data.length, data);

        // Trash the original
        await mount.updatePath(fileId, { trashedAt: new Date() });

        // Should be able to create a new file with the same name
        const newData = Buffer.from('replacement');
        const newFileId = await mount.createFile(rootId, 'reusable-name.txt', 'text/plain', newData.length, newData);
        expect(newFileId).not.toBe(fileId);

        const newFile = await mount.getPath(newFileId);
        expect(newFile).not.toBeNull();
        expect(newFile!.name).toBe('reusable-name.txt');
        expect(newFile!.trashedAt).toBeNull();
    });
});

describe('trashPath (local-key storage)', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-trash-lk', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const root = await mount.getRootFolder();
        rootId = root!.id;
    });

    test('trash a file sets trashedAt, trashedFrom, and parentId=root', async () => {
        const folderId = await mount.createFolder(rootId, 'TrashFileParent');
        const data = Buffer.from('trash-me');
        const fileId = await mount.createFile(folderId, 'trash-me.txt', 'text/plain', data.length, data);

        const result = await mount.trashPath(fileId);
        expect(result.trashedAt).not.toBeNull();
        expect(result.parentId).toBe(rootId);

        const file = await mount.getPath(fileId);
        expect(file!.trashedAt).not.toBeNull();
        expect(file!.parentId).toBe(rootId);

        // Storage file still accessible (key-based storage doesn't move files)
        const storageFile = await mount.readFile(fileId);
        expect(storageFile).not.toBeNull();
        const content = new TextDecoder().decode(await storageFile!.arrayBuffer());
        expect(content).toBe('trash-me');
    });

    test('trash a file preserves acl column', async () => {
        const data = Buffer.from('acl-test');
        const fileId = await mount.createFile(rootId, 'acl-preserve.txt', 'text/plain', data.length, data);
        const testAcl = [{ id: 'user-1', read: true, write: false }];
        await mount.updatePath(fileId, { acl: testAcl });

        await mount.trashPath(fileId);

        const file = await mount.getPath(fileId);
        expect(file!.acl).toEqual(testAcl);
    });

    test('trash a folder sets trashedAt on folder and all descendants', async () => {
        const folderId = await mount.createFolder(rootId, 'TrashFolderDeep');
        const subId = await mount.createFolder(folderId, 'SubFolder');
        const fileId = await mount.createFile(subId, 'deep.txt', 'text/plain', 4, Buffer.from('deep'));

        await mount.trashPath(folderId);

        const folder = await mount.getPath(folderId);
        const sub = await mount.getPath(subId);
        const file = await mount.getPath(fileId);
        expect(folder!.trashedAt).not.toBeNull();
        expect(sub!.trashedAt).not.toBeNull();
        expect(file!.trashedAt).not.toBeNull();
    });

    test('trash a folder: descendants get trashedFrom=null', async () => {
        const folderId = await mount.createFolder(rootId, 'TrashFolderDescendants');
        const childId = await mount.createFile(folderId, 'child.txt', 'text/plain', 5, Buffer.from('child'));

        await mount.trashPath(folderId);

        // Folder itself should have trashedFrom set (it's the top-level trashed item)
        const trashList = await mount.listTrash();
        const folderInTrash = trashList.find((t) => t.id === folderId);
        expect(folderInTrash).not.toBeUndefined();

        // Child should NOT appear in trash list (trashedFrom is null)
        const childInTrash = trashList.find((t) => t.id === childId);
        expect(childInTrash).toBeUndefined();
    });

    test('trash a folder with already-trashed child: child keeps its own trashedFrom', async () => {
        const folderId = await mount.createFolder(rootId, 'TrashNestedPrior');
        const childId = await mount.createFile(folderId, 'nested.txt', 'text/plain', 6, Buffer.from('nested'));

        // Trash the child first
        await mount.trashPath(childId);
        const childAfterTrash = await mount.getPath(childId);
        expect(childAfterTrash!.trashedAt).not.toBeNull();

        // Now trash the folder
        await mount.trashPath(folderId);

        // Child should still appear as independently trashed in listTrash
        const trashList = await mount.listTrash();
        const childInTrash = trashList.find((t) => t.id === childId);
        expect(childInTrash).not.toBeUndefined();
    });

    test('trash root folder throws 400', async () => {
        expect(mount.trashPath(rootId)).rejects.toThrow('Cannot trash root folder');
    });

    test('trash non-existent path throws 404', async () => {
        expect(mount.trashPath('nonexistent-id')).rejects.toThrow('Path not found');
    });

    test('listTrash returns only trashedFrom IS NOT NULL items, ordered by trashedAt desc', async () => {
        const config2 = createDefaultMountConfig('test-trash-list-lk', 'local-key');
        const mount2 = new Mount(OWNER_ID, TEST_DIR, config2, createGetLocalDatabase(TEST_DIR));
        await mount2.init();
        const root2 = (await mount2.getRootFolder())!;

        const f1 = await mount2.createFile(root2.id, 'first.txt', 'text/plain', 5, Buffer.from('first'));
        const f2 = await mount2.createFile(root2.id, 'second.txt', 'text/plain', 6, Buffer.from('second'));

        await mount2.trashPath(f1);
        // Backdate f1's trashedAt so f2 is newer (avoids a 1s+ sleep)
        await mount2.updatePath(f1, { trashedAt: new Date(Date.now() - 60_000) });
        await mount2.trashPath(f2);

        const trash = await mount2.listTrash();
        expect(trash.length).toBe(2);
        // Newest first
        expect(trash[0].id).toBe(f2);
        expect(trash[1].id).toBe(f1);
    });
});

describe('trashPath (local path-based storage)', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-trash-local', 'local');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const root = await mount.getRootFolder();
        rootId = root!.id;
    });

    test('.trash directory exists after init', () => {
        expect(existsSync(join(mount.dataDir, '.trash'))).toBe(true);
    });

    test('trash a file moves to .trash/{pathId}.ext on disk', async () => {
        const folderId = await mount.createFolder(rootId, 'TrashLocalFile');
        const data = Buffer.from('local-trash');
        const fileId = await mount.createFile(folderId, 'report.pdf', 'application/pdf', data.length, data);

        expect(existsSync(join(mount.dataDir, 'TrashLocalFile', 'report.pdf'))).toBe(true);

        await mount.trashPath(fileId);

        const expectedTrashKey = buildStorageKey(fileId, 'report.pdf');
        expect(existsSync(join(mount.dataDir, '.trash', expectedTrashKey))).toBe(true);
        expect(existsSync(join(mount.dataDir, 'TrashLocalFile', 'report.pdf'))).toBe(false);
    });

    test('trash a file updates file column and content is still readable', async () => {
        const data = Buffer.from('file-col-test');
        const fileId = await mount.createFile(rootId, 'filecol.txt', 'text/plain', data.length, data);

        await mount.trashPath(fileId);

        const file = await mount.getPath(fileId);
        expect(file!.name).toBe('filecol.txt');
        // Content should still be readable via the updated storage path
        const content = await mount.readFile(fileId);
        expect(content).not.toBeNull();
        expect(await content!.text()).toBe('file-col-test');
    });

    test('trash a folder moves to .trash/{pathId}/ on disk', async () => {
        const folderId = await mount.createFolder(rootId, 'TrashLocalFolder');
        await mount.createFile(folderId, 'inside.txt', 'text/plain', 5, Buffer.from('inner'));

        expect(existsSync(join(mount.dataDir, 'TrashLocalFolder'))).toBe(true);

        await mount.trashPath(folderId);

        // Folder should be at .trash/{folderId} (no extension for folders)
        const expectedTrashKey = buildStorageKey(folderId, 'TrashLocalFolder');
        expect(existsSync(join(mount.dataDir, '.trash', expectedTrashKey))).toBe(true);
        expect(existsSync(join(mount.dataDir, 'TrashLocalFolder'))).toBe(false);
        // Content should still be inside
        expect(existsSync(join(mount.dataDir, '.trash', expectedTrashKey, 'inside.txt'))).toBe(true);
    });

    test('trash a folder: descendants file columns unchanged', async () => {
        const folderId = await mount.createFolder(rootId, 'TrashDescFile');
        const childId = await mount.createFile(folderId, 'child.txt', 'text/plain', 5, Buffer.from('child'));

        const childBefore = await mount.getPath(childId);

        await mount.trashPath(folderId);

        const childAfter = await mount.getPath(childId);
        // The child's name/file column should be unchanged
        expect(childAfter!.name).toBe(childBefore!.name);
    });

    test('after trash, create new file with same name: no collision on disk', async () => {
        const folderId = await mount.createFolder(rootId, 'TrashCollision');
        const data1 = Buffer.from('original');
        const file1Id = await mount.createFile(folderId, 'same.txt', 'text/plain', data1.length, data1);

        await mount.trashPath(file1Id);

        const data2 = Buffer.from('replacement');
        const file2Id = await mount.createFile(folderId, 'same.txt', 'text/plain', data2.length, data2);

        // Both should be accessible
        const content1 = await mount.readFile(file1Id);
        const content2 = await mount.readFile(file2Id);
        expect(content1).not.toBeNull();
        expect(content2).not.toBeNull();
        expect(await content1!.text()).toBe('original');
        expect(await content2!.text()).toBe('replacement');
    });

    test('trash a file: trashedAt, trashedFrom, parentId set correctly', async () => {
        const folderId = await mount.createFolder(rootId, 'TrashLocalMeta');
        const data = Buffer.from('meta-test');
        const fileId = await mount.createFile(folderId, 'meta.txt', 'text/plain', data.length, data);

        const result = await mount.trashPath(fileId);
        expect(result.trashedAt).not.toBeNull();
        expect(result.parentId).toBe(rootId);
    });

    // The P1 trash-wipe alias: a user folder named .trash would resolve to the REAL trash dir
    // (data/.trash), so deleting it deleted every trashed file's bytes. Reserved in validateName.
    test('no user path can alias the real trash dir — trashed bytes survive', async () => {
        const data = Buffer.from('must-survive');
        const fileId = await mount.createFile(rootId, 'survive.txt', 'text/plain', data.length, data);
        await mount.trashPath(fileId);
        const trashKey = buildStorageKey(fileId, 'survive.txt');
        expect(existsSync(join(mount.dataDir, '.trash', trashKey))).toBe(true);

        expect(mount.createFolder(rootId, '.trash')).rejects.toThrow('reserved name');
        expect(mount.createFolder(rootId, '.Trash')).rejects.toThrow('reserved name');

        expect(existsSync(join(mount.dataDir, '.trash', trashKey))).toBe(true);
        const restored = await mount.restorePath(fileId);
        expect(await (await mount.readFile(restored.id))!.text()).toBe('must-survive');
    });
});

describe('restorePath (local-key storage)', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-restore-lk', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const root = await mount.getRootFolder();
        rootId = root!.id;
    });

    test('restore a file clears trashedAt, trashedFrom, restores parentId', async () => {
        const folderId = await mount.createFolder(rootId, 'RestoreFileParent');
        const data = Buffer.from('restore-me');
        const fileId = await mount.createFile(folderId, 'restore.txt', 'text/plain', data.length, data);

        await mount.trashPath(fileId);
        const trashed = await mount.getPath(fileId);
        expect(trashed!.trashedAt).not.toBeNull();
        expect(trashed!.parentId).toBe(rootId);

        const restored = await mount.restorePath(fileId);
        expect(restored.trashedAt).toBeNull();
        expect(restored.parentId).toBe(folderId);
    });

    test('restore a folder clears flags on folder and non-independently-trashed descendants', async () => {
        const folderId = await mount.createFolder(rootId, 'RestoreFolderDeep');
        const subId = await mount.createFolder(folderId, 'Sub');
        const fileId = await mount.createFile(subId, 'deep.txt', 'text/plain', 4, Buffer.from('deep'));

        await mount.trashPath(folderId);

        // All should be trashed
        expect((await mount.getPath(subId))!.trashedAt).not.toBeNull();
        expect((await mount.getPath(fileId))!.trashedAt).not.toBeNull();

        await mount.restorePath(folderId);

        const folder = await mount.getPath(folderId);
        const sub = await mount.getPath(subId);
        const file = await mount.getPath(fileId);
        expect(folder!.trashedAt).toBeNull();
        expect(sub!.trashedAt).toBeNull();
        expect(file!.trashedAt).toBeNull();
    });

    test('restore a folder: descendants with trashedFrom IS NOT NULL stay trashed', async () => {
        const folderId = await mount.createFolder(rootId, 'RestoreIndepTrash');
        const childId = await mount.createFile(folderId, 'indep.txt', 'text/plain', 5, Buffer.from('indep'));

        // Trash child independently first
        await mount.trashPath(childId);

        // Then trash the folder
        await mount.trashPath(folderId);

        // Restore the folder
        await mount.restorePath(folderId);

        const folder = await mount.getPath(folderId);
        const child = await mount.getPath(childId);
        expect(folder!.trashedAt).toBeNull();
        // Child was independently trashed — should still be in trash
        expect(child!.trashedAt).not.toBeNull();
    });

    test('restore when original parent deleted restores to root', async () => {
        const folderId = await mount.createFolder(rootId, 'RestoreDeletedParent');
        const data = Buffer.from('orphan');
        const fileId = await mount.createFile(folderId, 'orphan.txt', 'text/plain', data.length, data);

        await mount.trashPath(fileId);
        // Delete the original parent permanently
        await mount.deletePath(folderId);

        const restored = await mount.restorePath(fileId);
        expect(restored.parentId).toBe(rootId);
        expect(restored.trashedAt).toBeNull();
    });

    test('restore when original parent trashed restores to root', async () => {
        const folderId = await mount.createFolder(rootId, 'RestoreTrashedParent');
        const data = Buffer.from('nested-orphan');
        const fileId = await mount.createFile(folderId, 'nested-orphan.txt', 'text/plain', data.length, data);

        // Trash the file first
        await mount.trashPath(fileId);
        // Then trash the parent
        await mount.trashPath(folderId);

        const restored = await mount.restorePath(fileId);
        expect(restored.parentId).toBe(rootId);
        expect(restored.trashedAt).toBeNull();
    });

    test('restore with name conflict auto-renames', async () => {
        const folderId = await mount.createFolder(rootId, 'RestoreConflict');
        const data1 = Buffer.from('original');
        const fileId = await mount.createFile(folderId, 'conflict.txt', 'text/plain', data1.length, data1);

        await mount.trashPath(fileId);

        // Create a new file with the same name
        const data2 = Buffer.from('blocker');
        await mount.createFile(folderId, 'conflict.txt', 'text/plain', data2.length, data2);

        const restored = await mount.restorePath(fileId);
        expect(restored.parentId).toBe(folderId);
        expect(restored.name).not.toBe('conflict.txt');
        expect(restored.name).toContain('conflict');
    });

    test('restore non-trashed item throws 400', async () => {
        const data = Buffer.from('not-trashed');
        const fileId = await mount.createFile(rootId, 'not-trashed.txt', 'text/plain', data.length, data);

        expect(mount.restorePath(fileId)).rejects.toThrow('Item is not in trash');
    });
});

describe('restorePath (local path-based storage)', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-restore-local', 'local');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const root = await mount.getRootFolder();
        rootId = root!.id;
    });

    test('restore file moves back from .trash/, file column = name', async () => {
        const folderId = await mount.createFolder(rootId, 'RestoreLocalFile');
        const data = Buffer.from('restore-local');
        const fileId = await mount.createFile(folderId, 'back.txt', 'text/plain', data.length, data);

        await mount.trashPath(fileId);

        // Verify file is in .trash/
        const trashKey = buildStorageKey(fileId, 'back.txt');
        expect(existsSync(join(mount.dataDir, '.trash', trashKey))).toBe(true);
        expect(existsSync(join(mount.dataDir, 'RestoreLocalFile', 'back.txt'))).toBe(false);

        await mount.restorePath(fileId);

        // Verify file is back
        expect(existsSync(join(mount.dataDir, 'RestoreLocalFile', 'back.txt'))).toBe(true);
        expect(existsSync(join(mount.dataDir, '.trash', trashKey))).toBe(false);

        // Verify content
        const content = await mount.readFile(fileId);
        expect(content).not.toBeNull();
        expect(await content!.text()).toBe('restore-local');
    });

    test('restore folder moves back from .trash/', async () => {
        const folderId = await mount.createFolder(rootId, 'RestoreLocalFolder');
        await mount.createFile(folderId, 'inside.txt', 'text/plain', 6, Buffer.from('inside'));

        await mount.trashPath(folderId);

        const trashKey = buildStorageKey(folderId, 'RestoreLocalFolder');
        expect(existsSync(join(mount.dataDir, '.trash', trashKey))).toBe(true);

        await mount.restorePath(folderId);

        expect(existsSync(join(mount.dataDir, 'RestoreLocalFolder'))).toBe(true);
        expect(existsSync(join(mount.dataDir, 'RestoreLocalFolder', 'inside.txt'))).toBe(true);
    });

    test('restore with name conflict auto-renames on disk too', async () => {
        const folderId = await mount.createFolder(rootId, 'RestoreLocalConflict');
        const data1 = Buffer.from('first');
        const fileId = await mount.createFile(folderId, 'dupe.txt', 'text/plain', data1.length, data1);

        await mount.trashPath(fileId);

        // Create blocker
        await mount.createFile(folderId, 'dupe.txt', 'text/plain', 6, Buffer.from('blocker'));

        const restored = await mount.restorePath(fileId);
        expect(restored.name).not.toBe('dupe.txt');
        // The restored file should exist on disk with the new name
        expect(existsSync(join(mount.dataDir, 'RestoreLocalConflict', restored.name))).toBe(true);
    });

    test('restore when original parent deleted restores to root', async () => {
        const folderId = await mount.createFolder(rootId, 'RestoreLocalDelParent');
        const data = Buffer.from('orphan-local');
        const fileId = await mount.createFile(folderId, 'orphan-local.txt', 'text/plain', data.length, data);

        await mount.trashPath(fileId);
        await mount.deletePath(folderId);

        const restored = await mount.restorePath(fileId);
        expect(restored.parentId).toBe(rootId);
        // File should exist at root on disk
        expect(existsSync(join(mount.dataDir, restored.name))).toBe(true);
    });

    // Rows named .trash created before the reserved-name guard can exist on live installs;
    // restoring one must conflict-rename, never land on the real trash dir.
    test('restore of a legacy trashed row named .trash lands with a renamed name', async () => {
        const folderId = await mount.createFolder(rootId, 'LegacyTrashName');
        await mount.createFile(folderId, 'inside.txt', 'text/plain', 6, Buffer.from('legacy'));
        await mount.trashPath(folderId);
        // Simulate a pre-guard row: rename directly in the db, bypassing validateName.
        await mount.db.update(paths).set({ name: '.trash' }).where(eq(paths.id, folderId));

        const restored = await mount.restorePath(folderId);
        expect(restored.name.toLowerCase()).not.toBe('.trash');
        expect(existsSync(join(mount.dataDir, restored.name, 'inside.txt'))).toBe(true);
        // The real trash dir is still a directory at data/.trash
        expect(existsSync(join(mount.dataDir, '.trash'))).toBe(true);
    });
});

describe('permanentlyDeleteFromTrash and purgeTrash', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-perm-delete', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const root = await mount.getRootFolder();
        rootId = root!.id;
    });

    test('permanently delete a trashed file — DB row gone, storage file gone', async () => {
        const data = Buffer.from('perm-delete-file');
        const fileId = await mount.createFile(rootId, 'perm-delete.txt', 'text/plain', data.length, data);

        await mount.trashPath(fileId);
        expect((await mount.getPath(fileId))?.trashedAt).not.toBeNull();

        await mount.permanentlyDeleteFromTrash(fileId);
        expect(await mount.getPath(fileId)).toBeNull();
    });

    test('permanently delete a trashed folder — folder and all descendants gone', async () => {
        const folderId = await mount.createFolder(rootId, 'PermanentFolder');
        const subId = await mount.createFolder(folderId, 'Sub');
        const fileId = await mount.createFile(subId, 'nested.txt', 'text/plain', 3, Buffer.from('abc'));

        await mount.trashPath(folderId);
        await mount.permanentlyDeleteFromTrash(folderId);

        expect(await mount.getPath(folderId)).toBeNull();
        expect(await mount.getPath(subId)).toBeNull();
        expect(await mount.getPath(fileId)).toBeNull();
    });

    test('permanently delete folder with independently-trashed orphan child — both deleted', async () => {
        const folderId = await mount.createFolder(rootId, 'OrphanParent');
        const childId = await mount.createFile(folderId, 'orphan-child.txt', 'text/plain', 5, Buffer.from('child'));

        // Trash the child independently first (it gets trashedFrom = folderId, parentId = rootId)
        await mount.trashPath(childId);
        const childAfter = await mount.getPath(childId);
        expect(childAfter?.trashedAt).not.toBeNull();

        // Trash and then permanently delete the folder
        await mount.trashPath(folderId);
        await mount.permanentlyDeleteFromTrash(folderId);

        // Both the folder and the orphaned child should be gone
        expect(await mount.getPath(folderId)).toBeNull();
        expect(await mount.getPath(childId)).toBeNull();
    });

    test('purgeTrash() with no args deletes all trashed items', async () => {
        const config2 = createDefaultMountConfig('test-purge-all', 'local-key');
        const mount2 = new Mount(OWNER_ID, TEST_DIR, config2, createGetLocalDatabase(TEST_DIR));
        await mount2.init();
        const root2 = (await mount2.getRootFolder())!;

        const f1 = await mount2.createFile(root2.id, 'purge1.txt', 'text/plain', 1, Buffer.from('a'));
        const f2 = await mount2.createFile(root2.id, 'purge2.txt', 'text/plain', 1, Buffer.from('b'));
        await mount2.trashPath(f1);
        await mount2.trashPath(f2);

        const trashBefore = await mount2.listTrash();
        expect(trashBefore.length).toBe(2);

        await mount2.purgeTrash();

        expect(await mount2.getPath(f1)).toBeNull();
        expect(await mount2.getPath(f2)).toBeNull();

        const trashAfter = await mount2.listTrash();
        expect(trashAfter.length).toBe(0);
    });

    test('purgeTrash() on empty trash — no error', async () => {
        const config3 = createDefaultMountConfig('test-purge-empty', 'local-key');
        const mount3 = new Mount(OWNER_ID, TEST_DIR, config3, createGetLocalDatabase(TEST_DIR));
        await mount3.init();

        await expect(mount3.purgeTrash()).resolves.toBeUndefined();
    });

    test('purgeTrash(30) deletes old items, keeps recent ones', async () => {
        const config4 = createDefaultMountConfig('test-purge-age', 'local-key');
        const mount4 = new Mount(OWNER_ID, TEST_DIR, config4, createGetLocalDatabase(TEST_DIR));
        await mount4.init();
        const root4 = (await mount4.getRootFolder())!;

        const oldId = await mount4.createFile(root4.id, 'old-file.txt', 'text/plain', 3, Buffer.from('old'));
        const newId = await mount4.createFile(root4.id, 'new-file.txt', 'text/plain', 3, Buffer.from('new'));

        await mount4.trashPath(oldId);
        await mount4.trashPath(newId);

        // Backdate the old item's trashedAt to 31 days ago
        const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
        await mount4.updatePath(oldId, { trashedAt: oldDate });

        await mount4.purgeTrash(30);

        // The old item should be deleted
        expect(await mount4.getPath(oldId)).toBeNull();
        // The new item (trashed just now) should still exist
        expect(await mount4.getPath(newId)).not.toBeNull();
    });

    test('permanentlyDeleteFromTrash on non-trashed item throws 400', async () => {
        const fileId = await mount.createFile(rootId, 'not-trashed2.txt', 'text/plain', 3, Buffer.from('nop'));
        await expect(mount.permanentlyDeleteFromTrash(fileId)).rejects.toThrow('Item is not in trash');
    });

    test('permanentlyDeleteFromTrash on non-existent item is a no-op', async () => {
        await expect(mount.permanentlyDeleteFromTrash('nonexistent-id-xyz')).resolves.toBeUndefined();
    });
});

describe('Folder sizes', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-folder-sizes', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const root = await mount.getRootFolder();
        rootId = root!.id;
    });

    test('empty folder reports size 0', async () => {
        const folderId = await mount.createFolder(rootId, 'EmptySize');
        const folder = await mount.getPath(folderId);
        expect(folder!.size).toBe(0);
    });

    test('folder size sums file children', async () => {
        const folderId = await mount.createFolder(rootId, 'SumChildren');
        await mount.createFile(folderId, 'a.txt', 'text/plain', 5, Buffer.from('aaaaa'));
        await mount.createFile(folderId, 'b.txt', 'text/plain', 7, Buffer.from('bbbbbbb'));

        const folder = await mount.getPath(folderId);
        expect(folder!.size).toBe(12);
    });

    test('folder size cascades through subfolders', async () => {
        const topId = await mount.createFolder(rootId, 'CascadeTop');
        const midId = await mount.createFolder(topId, 'CascadeMid');
        const leafId = await mount.createFolder(midId, 'CascadeLeaf');
        await mount.createFile(leafId, 'deep.txt', 'text/plain', 10, Buffer.from('1234567890'));

        expect((await mount.getPath(leafId))!.size).toBe(10);
        expect((await mount.getPath(midId))!.size).toBe(10);
        expect((await mount.getPath(topId))!.size).toBe(10);
    });

    test('createFile invalidates ancestor sizes', async () => {
        const folderId = await mount.createFolder(rootId, 'InvalidateOnCreate');
        await mount.createFile(folderId, 'first.txt', 'text/plain', 3, Buffer.from('xxx'));
        expect((await mount.getPath(folderId))!.size).toBe(3);

        await mount.createFile(folderId, 'second.txt', 'text/plain', 4, Buffer.from('yyyy'));
        expect((await mount.getPath(folderId))!.size).toBe(7);
    });

    test('writeFile propagates new size to ancestors', async () => {
        const folderId = await mount.createFolder(rootId, 'WriteFilePropagate');
        const fileId = await mount.createFile(folderId, 'grow.txt', 'text/plain', 5, Buffer.from('small'));
        expect((await mount.getPath(folderId))!.size).toBe(5);

        await mount.writeFile(fileId, Buffer.from('much-bigger-content'));
        expect((await mount.getPath(folderId))!.size).toBe(19);
    });

    test('deletePath decreases ancestor sizes', async () => {
        const folderId = await mount.createFolder(rootId, 'DeletePropagate');
        const f1 = await mount.createFile(folderId, '1.txt', 'text/plain', 4, Buffer.from('1234'));
        await mount.createFile(folderId, '2.txt', 'text/plain', 6, Buffer.from('567890'));
        expect((await mount.getPath(folderId))!.size).toBe(10);

        await mount.deletePath(f1);
        expect((await mount.getPath(folderId))!.size).toBe(6);
    });

    test('move file between folders updates both ancestor chains', async () => {
        const aId = await mount.createFolder(rootId, 'MoveFromA');
        const bId = await mount.createFolder(rootId, 'MoveToB');
        const fileId = await mount.createFile(aId, 'movable.txt', 'text/plain', 7, Buffer.from('payload'));

        expect((await mount.getPath(aId))!.size).toBe(7);
        expect((await mount.getPath(bId))!.size).toBe(0);

        await mount.updatePath(fileId, { parentId: bId });

        expect((await mount.getPath(aId))!.size).toBe(0);
        expect((await mount.getPath(bId))!.size).toBe(7);
    });

    test('copyPath grows destination ancestor sizes', async () => {
        const srcFolder = await mount.createFolder(rootId, 'CopySrc');
        const dstFolder = await mount.createFolder(rootId, 'CopyDst');
        const fileId = await mount.createFile(srcFolder, 'orig.txt', 'text/plain', 7, Buffer.from('copy-me'));

        expect((await mount.getPath(srcFolder))!.size).toBe(7);
        expect((await mount.getPath(dstFolder))!.size).toBe(0);

        await mount.copyPath(fileId, dstFolder, 'copied.txt');

        expect((await mount.getPath(srcFolder))!.size).toBe(7);
        expect((await mount.getPath(dstFolder))!.size).toBe(7);
    });

    test('trashPath removes file size from old parent', async () => {
        const folderId = await mount.createFolder(rootId, 'TrashShrink');
        const fileId = await mount.createFile(folderId, 'trash.txt', 'text/plain', 5, Buffer.from('bytes'));
        expect((await mount.getPath(folderId))!.size).toBe(5);

        await mount.trashPath(fileId);
        expect((await mount.getPath(folderId))!.size).toBe(0);
    });

    test('trashed file at root does not inflate root size', async () => {
        const folderId = await mount.createFolder(rootId, 'TrashRootExclude');
        const fileId = await mount.createFile(folderId, 'trashed.txt', 'text/plain', 5, Buffer.from('XXXXX'));
        const rootBefore = (await mount.getPath(rootId))!.size;

        await mount.trashPath(fileId);
        // Folder size dropped to 0; the file is now under root with trashedFrom set,
        // and the trash-boundary filter must exclude it from root's recomputed size.
        const rootAfter = (await mount.getPath(rootId))!.size;
        expect(rootAfter).toBe(rootBefore - 5);
    });

    test('restorePath adds size back to restored parent', async () => {
        const folderId = await mount.createFolder(rootId, 'RestoreGrow');
        const fileId = await mount.createFile(folderId, 'restore.txt', 'text/plain', 4, Buffer.from('back'));
        expect((await mount.getPath(folderId))!.size).toBe(4);

        await mount.trashPath(fileId);
        expect((await mount.getPath(folderId))!.size).toBe(0);

        await mount.restorePath(fileId);
        expect((await mount.getPath(folderId))!.size).toBe(4);
    });

    test('peeking inside a trashed folder still shows its descendant sizes', async () => {
        const folderId = await mount.createFolder(rootId, 'TrashedFolderInternals');
        await mount.createFile(folderId, 'inside.txt', 'text/plain', 6, Buffer.from('hidden'));
        expect((await mount.getPath(folderId))!.size).toBe(6);

        await mount.trashPath(folderId);

        // The trashed folder itself still reports its real content size — useful for
        // showing "what you'd recover / free" in a trash listing.
        const trashed = await mount.getPath(folderId);
        expect(trashed!.trashedAt).not.toBeNull();
        expect(trashed!.size).toBe(6);
    });

    test('listFolder returns folders with computed sizes', async () => {
        const parentId = await mount.createFolder(rootId, 'ListSized');
        const child1 = await mount.createFolder(parentId, 'Child1');
        const child2 = await mount.createFolder(parentId, 'Child2');
        await mount.createFile(child1, 'c1.txt', 'text/plain', 2, Buffer.from('aa'));
        await mount.createFile(child2, 'c2.txt', 'text/plain', 4, Buffer.from('bbbb'));

        const children = await mount.listFolder(parentId);
        const c1 = children.find((c) => c.id === child1)!;
        const c2 = children.find((c) => c.id === child2)!;
        expect(c1.size).toBe(2);
        expect(c2.size).toBe(4);
    });

    test('path-based move invalidates both chains', async () => {
        const config = createDefaultMountConfig('test-folder-sizes-local', 'local');
        const m = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await m.init();
        const root = (await m.getRootFolder())!;

        const aId = await m.createFolder(root.id, 'PathMoveA');
        const bId = await m.createFolder(root.id, 'PathMoveB');
        const fileId = await m.createFile(aId, 'movable.txt', 'text/plain', 7, Buffer.from('payload'));

        expect((await m.getPath(aId))!.size).toBe(7);
        expect((await m.getPath(bId))!.size).toBe(0);

        await m.updatePath(fileId, { parentId: bId });

        expect((await m.getPath(aId))!.size).toBe(0);
        expect((await m.getPath(bId))!.size).toBe(7);
    });

    test('managed-db growth updates container size on sync', async () => {
        const testDocSchema = {
            items: sqliteTable('items', {
                id: integer('id').primaryKey(),
                data: text('data'),
            }),
        };
        const testDocConfig: DatabaseConfig<typeof testDocSchema> = {
            name: 'test-doc',
            currentVersion: 1,
            schema: testDocSchema,
            migrations: [
                {
                    version: 1,
                    up: (db) => {
                        db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)`);
                    },
                },
            ],
        };

        const containerId = await mount.createFolder(rootId, 'DocContainer', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');

        const managed = await mount.createDatabase(testDocConfig, dataDbId);
        for (let i = 0; i < 50; i++) {
            managed.db
                .insert(testDocSchema.items)
                .values({ id: i, data: 'x'.repeat(200) })
                .run();
        }
        await managed.close();

        const dataRow = await mount.getPath(dataDbId);
        expect(dataRow!.size).toBeGreaterThan(0);

        const container = await mount.getPath(containerId);
        // Container's only child is data.db, so the container's lazy-recomputed
        // size should match the data.db row's size.
        expect(container!.size).toBe(dataRow!.size);
    });
});

describe('Managed-db open vs create', () => {
    const minimalSchema = {
        items: sqliteTable('items', {
            id: integer('id').primaryKey(),
        }),
    };
    const minimalConfig: DatabaseConfig<typeof minimalSchema> = {
        name: 'open-create-test',
        currentVersion: 1,
        schema: minimalSchema,
        migrations: [
            {
                version: 1,
                up: (db) => {
                    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
                },
            },
        ],
    };

    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-open-create', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        rootId = (await mount.getRootFolder())!.id;
    });

    test('openDatabase throws when the storage object is missing', async () => {
        const containerId = await mount.createFolder(rootId, 'StrictOpenMissing', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
        // touchFile created the metadata row but no actual storage object — the
        // exact state the old openDatabase would have masked by silently
        // creating a fresh DB.
        expect(mount.openDatabase(minimalConfig, dataDbId)).rejects.toThrow('not available');
    });

    test('createDatabase provisions a real storage object', async () => {
        const containerId = await mount.createFolder(rootId, 'CreateProvisions', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');

        // Pre-condition: touchFile creates the metadata row but no storage
        // object — openDatabase must reject.
        expect(mount.openDatabase(minimalConfig, dataDbId)).rejects.toThrow('not available');

        await mount.createDatabase(minimalConfig, dataDbId);
        await mount.closeDatabase(dataDbId);

        // After close, syncDocumentDbSize stats the now-populated storage
        // object and writes the size into the metadata row. A non-zero size
        // proves a real SQLite file was created and persisted — i.e. that
        // openDatabase on the same path from a fresh process (after a restart)
        // would find a real object. We don't reopen in-process because Bun +
        // Drizzle's cached prepared statements keep file refs alive past
        // rawDb.close() and trip SQLITE_IOERR_VNODE; production doesn't hit
        // this since a real restart drops all handles.
        const dataRow = await mount.getPath(dataDbId);
        expect(dataRow!.size).toBeGreaterThan(0);
    });

    test('createDatabase twice for the same path throws on the second call', async () => {
        const containerId = await mount.createFolder(rootId, 'DoubleCreate', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');

        await mount.createDatabase(minimalConfig, dataDbId);
        expect(mount.createDatabase(minimalConfig, dataDbId)).rejects.toThrow('already in cache');
        await mount.closeDatabase(dataDbId);
    });

    // A close whose final sync FAILED must not cleanupTemp: the temp is the only copy holding
    // the unsynced tail, and a surviving temp is the Phase 1a unclean-shutdown marker the next
    // open adopts + re-syncs. Deleting it would silently serve stale storage bytes on reopen.
    test('close() with a failing final sync rejects but leaves the crash-recovery temp', async () => {
        const config = createDefaultMountConfig('test-failed-close', 'local');
        const failMount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await failMount.init();
        const failRootId = (await failMount.getRootFolder())!.id;
        const containerId = await failMount.createFolder(failRootId, 'FailedCloseDoc', 'doc');
        const dataDbId = await failMount.touchFile(containerId, 'data.db', 'application/x-sqlite3');

        const managed = await failMount.createDatabase(minimalConfig, dataDbId);
        managed.db.insert(minimalSchema.items).values({ id: 1 }).run();

        const storage = failMount.storage;
        const realWrite = storage.write.bind(storage);
        storage.write = async () => {
            throw new Error('injected write failure');
        };
        try {
            await expect(failMount.closeDatabase(dataDbId)).rejects.toThrow('injected write failure');
        } finally {
            storage.write = realWrite;
        }

        expect(existsSync(failMount.getTempPath(dataDbId))).toBe(true);
    });
});

describe('LocalStorage safety', () => {
    let storage: LocalStorage;

    beforeAll(() => {
        storage = new LocalStorage(join(TEST_DIR, 'safety-storage'));
    });

    test('rename throws when source does not exist', async () => {
        expect(storage.rename('nonexistent', 'target')).rejects.toThrow('source path not found');
    });
});

describe('content search (upsertPathContent / clearPathContent / searchPaths body)', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-content-search', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        rootId = (await mount.getRootFolder())!.id;
    });

    test('searchPaths finds a file by its body content and ranks name over body', async () => {
        // Two files: one whose NAME contains the term, one whose only BODY contains it.
        const bodyHit = await mount.createFile(rootId, 'quarterly-notes.txt', 'text/plain', 0, undefined);
        const nameHit = await mount.createFile(rootId, 'z004term-in-name.txt', 'text/plain', 0, undefined);
        mount.upsertPathContent(bodyHit, 'budget figures for z004term and more');

        const hits = mount.searchPaths({ q: 'z004term', limit: 20 });
        const ids = hits.map((h) => h.id);
        expect(ids).toContain(bodyHit);
        expect(ids).toContain(nameHit);
        // Name match outranks body-only match (structural boost).
        expect(ids.indexOf(nameHit)).toBeLessThan(ids.indexOf(bodyHit));
    });

    test('clearPathContent and AFTER DELETE both remove the content row from search', async () => {
        const f = await mount.createFile(rootId, 'plain.txt', 'text/plain', 0, undefined);
        mount.upsertPathContent(f, 'zelphine appears here');
        expect(mount.searchPaths({ q: 'zelphine', limit: 20 }).some((h) => h.id === f)).toBe(true);

        mount.clearPathContent(f);
        expect(mount.searchPaths({ q: 'zelphine', limit: 20 }).some((h) => h.id === f)).toBe(false);

        // Re-add, then delete the PATH — the AFTER DELETE trigger must clear path_content.
        mount.upsertPathContent(f, 'zelphine appears here');
        await mount.deletePath(f);
        expect(mount.searchPaths({ q: 'zelphine', limit: 20 }).some((h) => h.id === f)).toBe(false);
    });
});

describe('content index dirty marks', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-content-dirty', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        rootId = (await mount.getRootFolder())!.id;
    });

    test('creating a plaintext file marks it contentDirty; a binary file does not', async () => {
        const txt = await mount.createFile(rootId, 'marked.txt', 'text/plain', 0, undefined);
        const png = await mount.createFile(rootId, 'image.png', 'image/png', 0, undefined);
        const dirtyIds = mount.getContentDirtyPaths(0, 100).map((p) => p.id);
        expect(dirtyIds).toContain(txt);
        expect(dirtyIds).not.toContain(png);
    });

    test('getContentDirtyPaths honours the re-extract cap', async () => {
        const txt = await mount.createFile(rootId, 'cap-test.txt', 'text/plain', 0, undefined);
        expect(mount.getContentDirtyPaths(0, 100).map((p) => p.id)).toContain(txt);
        mount.markContentIndexed(txt);
        expect(mount.getContentDirtyPaths(120, 100).map((p) => p.id)).not.toContain(txt);
    });

    // Overwrites mirror createFile's isSearchableTextFile gate — a binary PUT must not queue a re-extract.
    test('overwriting a plaintext file re-marks it contentDirty; a binary overwrite does not', async () => {
        const txt = await mount.createFile(rootId, 'rewrite.txt', 'text/plain', 0, undefined);
        const png = await mount.createFile(rootId, 'rewrite.png', 'image/png', 0, undefined);
        mount.markContentIndexed(txt);
        mount.markContentIndexed(png);

        await mount.writeFile(txt, Buffer.from('fresh text'));
        await mount.writeFile(png, Buffer.from([137, 80, 78, 71]));

        const dirtyIds = mount.getContentDirtyPaths(-1, 100).map((p) => p.id);
        expect(dirtyIds).toContain(txt);
        expect(dirtyIds).not.toContain(png);
    });

    test('overwriting from a temp file (streaming PUT) follows the same searchable gate', async () => {
        const txt = await mount.createFile(rootId, 'stream.txt', 'text/plain', 0, undefined);
        const png = await mount.createFile(rootId, 'stream.png', 'image/png', 0, undefined);
        mount.markContentIndexed(txt);
        mount.markContentIndexed(png);

        await Bun.write(mount.getTempPath('overwrite-txt'), 'streamed text');
        await mount.writeFileFromTemp(txt, 'overwrite-txt', 13, 'hash-a');
        await Bun.write(mount.getTempPath('overwrite-png'), Buffer.from([137, 80, 78, 71]));
        await mount.writeFileFromTemp(png, 'overwrite-png', 4, 'hash-b');

        const dirtyIds = mount.getContentDirtyPaths(-1, 100).map((p) => p.id);
        expect(dirtyIds).toContain(txt);
        expect(dirtyIds).not.toContain(png);
    });
});

describe('trash/restore content reindex', () => {
    // A container trashed while contentDirty=1 is skipped by the drain (trashedAt filter), so restore
    // must re-kick the reindexer — otherwise its body search stays stale until the next unrelated write.
    test('restoring a trashed dirty container re-kicks the reindexer', async () => {
        const docSchema = { items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }) };
        const docConfig: DatabaseConfig<typeof docSchema> = {
            name: 'restore-reindex-test',
            currentVersion: 1,
            schema: docSchema,
            migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
        };
        let body = 'grendelone';
        let onExtract: (() => void) | undefined;
        const extract: ContentExtractor = async () => {
            onExtract?.();
            return body;
        };
        const config = createDefaultMountConfig('test-restore-reindex', 'local-key');
        const mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR), extract);
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;

        const containerId = await mount.createFolder(rootId, 'RestoreDoc', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
        const managed = await mount.createDatabase(docConfig, dataDbId);

        // First index: a synced write marks the container dirty; the drain extracts body v1.
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await managed.flush();
        await mount.flushContentReindex();
        expect(mount.searchPaths({ q: 'grendelone', limit: 20 }).some((h) => h.id === containerId)).toBe(true);

        // Dirty it again (the trash-time close syncs it, re-marking the container; the 2-min cap
        // defers that drain), then trash. Age the index stamp so a restore-time drain is due now.
        body = 'grendeltwo';
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await mount.trashPath(containerId);
        mount.db.run(sql`UPDATE paths SET contentIndexedAt = 0 WHERE id = ${containerId}`);

        const extracted = new Promise<void>((resolve) => {
            onExtract = resolve;
        });
        await mount.restorePath(containerId);
        // Pre-fix nothing re-drives the queue, so the extract signal never fires.
        const kicked = await Promise.race([extracted.then(() => true), Bun.sleep(300).then(() => false)]);
        await mount.closeAllDatabases(); // settles the in-flight drain + cancels timers before asserting
        expect(kicked).toBe(true);
        expect(mount.searchPaths({ q: 'grendeltwo', limit: 20 }).some((h) => h.id === containerId)).toBe(true);
    });
});

describe('content reindex failure handling', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-reindex-retry', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        rootId = (await mount.getRootFolder())!.id;
    });

    // A transient extract failure (S3 503/hiccup) must NOT clear the dirty bit — otherwise the doc is
    // dropped from body search until its next write. The failed attempt only stamps contentIndexedAt so
    // the 2-min cap defers the retry; a later successful drain then indexes it and clears the bit.
    test('a failed extract keeps the path dirty; a later success indexes it and clears the bit', async () => {
        const txt = await mount.createFile(rootId, 'reindex-retry.txt', 'text/plain', 0, undefined);

        let shouldThrow = true;
        const queue = new ContentReindexQueue({
            mount,
            label: 'retry-test',
            extract: async () => {
                if (shouldThrow) throw new Error('transient extract failure');
                return 'flibberretry body text';
            },
        });

        // Transient failure: the bit must survive (negative cap bypasses the window → returned iff dirty).
        await queue.drain();
        expect(mount.getContentDirtyPaths(-1, 100).map((p) => p.id)).toContain(txt);
        // The failed attempt stamped contentIndexedAt, so within the cap window the row is deferred —
        // still owed (dirty), but not due: no hot-spin on a persistently failing extract.
        expect(mount.getContentDirtyPaths(CONTENT_REINDEX_CAP_SECONDS, 100).map((p) => p.id)).not.toContain(txt);
        expect(mount.searchPaths({ q: 'flibberretry', limit: 20 }).some((h) => h.id === txt)).toBe(false);

        // Production retries once the 2-min cap elapses; age the attempt stamp so the drain sees the row
        // as due without a real wall-clock wait.
        const { db } = mount as unknown as { db: { run: (query: SQL) => unknown } };
        db.run(sql`UPDATE paths SET contentIndexedAt = 0 WHERE id = ${txt}`);

        // Retry succeeds: the body indexes and the bit is finally cleared.
        shouldThrow = false;
        await queue.drain();
        await queue.close();
        expect(mount.searchPaths({ q: 'flibberretry', limit: 20 }).some((h) => h.id === txt)).toBe(true);
        expect(mount.getContentDirtyPaths(-1, 100).map((p) => p.id)).not.toContain(txt);
    });
});
