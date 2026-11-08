// A backup copies the databases a mount manages under the lock of their document, and every other file byte for
// byte. A document's versions folder is found the way every lookup finds it, whatever the case of its name. A row that
// no path can be built for is told apart from the rest, and has no path of its own.
import { expect, test } from 'bun:test';
import type { DrivePathType } from '@workspace/lib/types/drive';
import type { MountPathRow } from '../../lib/backup/archive-layout';
import {
    archivePaths,
    listManagedDatabases,
    managedDbContainer,
    storageKeys,
    unreachableRows,
} from '../../lib/backup/archive-layout';

const row = (id: string, name: string, type: DrivePathType, parentId: string | null): MountPathRow => ({
    id,
    file: name,
    name,
    type,
    parentId,
    trashedFrom: null,
    size: 0,
    hash: null,
});

test("a version in a document's versions folder belongs to the document, whatever the folder's case", () => {
    const doc = row('doc', 'Plan.eigendoc', 'doc', 'root');
    for (const folderName of ['versions', 'Versions', 'VERSIONS']) {
        const folder = row('folder', folderName, 'folder', doc.id);
        const version = row('version', 'v1.db', 'file', folder.id);
        const byId = new Map([doc, folder, version].map((r) => [r.id, r]));
        expect(managedDbContainer(version, byId)).toBe(doc);
    }
});

test('a database in a plain folder is a file like any other', () => {
    const folder = row('folder', 'Versions', 'folder', 'root');
    const upload = row('upload', 'v1.db', 'file', folder.id);
    const byId = new Map([folder, upload].map((r) => [r.id, r]));
    expect(managedDbContainer(upload, byId)).toBeNull();
});

test('a row builds its path from the names above it, and a trash root sits in the trash folder', () => {
    const root = row('root', 'Drive', 'folder', null);
    const folder = { ...row('folder', 'Folder', 'folder', root.id), file: 'on-disk' };
    const file = row('file', 'a.txt', 'file', folder.id);
    const trashed = { ...row('trashed', 'b.txt', 'file', root.id), trashedFrom: folder.id };
    const rows = [file, trashed, folder, root];
    expect(archivePaths(rows)(file)).toBe('Folder/a.txt');
    expect(archivePaths(rows)(trashed)).toBe('.trash/trashed.txt');
    expect(storageKeys(rows, true)(file)).toBe('on-disk/a.txt');
    expect(storageKeys(rows, false)(file)).toBe('a.txt');
});

test('a row under a missing parent or in a parent cycle is orphaned, with what is under it, and has no path', () => {
    const root = row('root', 'Drive', 'folder', null);
    const kept = row('kept', 'Kept', 'folder', root.id);
    const lost = row('lost', 'Lost', 'folder', 'gone');
    const inLost = row('inLost', 'In lost', 'file', lost.id);
    const a = row('a', 'A', 'folder', 'b');
    const b = row('b', 'B', 'folder', a.id);
    const rows = [root, kept, lost, inLost, a, b];
    expect(unreachableRows(rows).orphaned.map((orphan) => orphan.id)).toEqual(['lost', 'inLost', 'a', 'b']);
    expect(() => archivePaths(rows)(inLost)).toThrow('path row inLost does not reach the root');
});

test('a managed database under a row that does not reach the root is not listed', () => {
    const root = row('root', 'Drive', 'folder', null);
    const doc = row('doc', 'Plan.eigendoc', 'doc', root.id);
    const data = row('data', 'data.db', 'file', doc.id);
    const stray = row('stray', 'Stray.eigendoc', 'doc', 'gone');
    const strayData = row('strayData', 'data.db', 'file', stray.id);
    expect(listManagedDatabases([root, doc, data, stray, strayData]).map((found) => found.row.id)).toEqual(['data']);
});

test('an empty file passes on a folder of a flat-key mount, and is unusable on a file', () => {
    const root = { ...row('root', 'Drive', 'folder', null), file: '' };
    const folder = { ...row('folder', 'Folder', 'folder', root.id), file: '' };
    expect(unreachableRows([root, folder]).unusable).toEqual([]);
    const file = { ...row('file', 'a.txt', 'file', folder.id), file: '' };
    expect(unreachableRows([root, folder, file]).unusable).toEqual([file]);
});

test('a name or file the trash folder reserves is unusable, and so is a separator', () => {
    const root = { ...row('root', 'Drive', 'folder', null), file: '' };
    const reserved = row('reserved', '.trash', 'file', root.id);
    const separator = { ...row('separator', 'a.txt', 'file', root.id), file: '../a.txt' };
    expect(unreachableRows([root, reserved, separator]).unusable).toEqual([reserved, separator]);
});
