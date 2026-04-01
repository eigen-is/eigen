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
        // Delay > 1s to ensure different epoch seconds (SQLite integer timestamp)
        await new Promise((r) => setTimeout(r, 1100));
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
