import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../lib/core';
import { getUniqueFileName } from '../lib/drive/naming';
import { buildStorageKey, createDefaultMountConfig, Mount } from '../lib/mount/mount';
import { LocalStorage } from '../lib/storage/local-storage';

const TEST_DIR = join(import.meta.dir, `../../../../data-test/test-mount-${Date.now()}`);
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
        expect(Buffer.from(content!).toString()).toBe('file content');
    });

    test('duplicate name throws 409', async () => {
        await mount.createFolder(rootId, 'UniqueFolder');
        expect(mount.createFolder(rootId, 'UniqueFolder')).rejects.toThrow();
    });

    test('case-insensitive duplicate name throws', async () => {
        await mount.createFolder(rootId, 'CaseSensitive');
        expect(mount.createFolder(rootId, 'casesensitive')).rejects.toThrow();
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
        expect(Buffer.from(content!).toString()).toBe('path-based content');
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

    test('rejects .. as file name', async () => {
        expect(mount.createFile(rootId, '..', 'text/plain', 0, undefined)).rejects.toThrow(
            'Invalid file or folder name',
        );
    });

    test('rejects .. on rename', async () => {
        const id = await mount.createFolder(rootId, 'ValidName');
        expect(mount.updatePath(id, { name: '..' })).rejects.toThrow('Invalid file or folder name');
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
    test('returns original if not in set', () => {
        const used = new Set(['other.txt']);
        expect(getUniqueFileName('photo.jpg', used)).toBe('photo#1.jpg');
    });

    test('increments number for simple collision', () => {
        const used = new Set(['photo.jpg', 'photo#1.jpg']);
        expect(getUniqueFileName('photo.jpg', used)).toBe('photo#2.jpg');
    });

    test('increments existing numbered file', () => {
        const used = new Set(['photo#3.jpg', 'photo#4.jpg']);
        expect(getUniqueFileName('photo#3.jpg', used)).toBe('photo#5.jpg');
    });

    test('handles file without extension', () => {
        const used = new Set(['readme', 'readme#1']);
        expect(getUniqueFileName('readme', used)).toBe('readme#2');
    });

    test('case-insensitive collision detection', () => {
        const used = new Set(['photo#1.jpg']);
        expect(getUniqueFileName('Photo.JPG', used)).toBe('Photo#2.JPG');
    });

    test('handles many collisions', () => {
        const used = new Set<string>();
        for (let i = 1; i <= 50; i++) used.add(`file#${i}.txt`);
        expect(getUniqueFileName('file.txt', used)).toBe('file#51.txt');
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
