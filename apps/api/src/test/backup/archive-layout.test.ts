// A backup copies the databases a mount manages under the lock of their document, and every other file byte for
// byte. A document's versions folder is found the way every lookup finds it, whatever the case of its name.
// Verify refuses a trash root whose permanent delete would wait on itself.
import { expect, test } from 'bun:test';
import type { DrivePathType } from '@workspace/lib/types/drive';
import type { MountPathRow } from '../../lib/backup/archive-layout';
import { checkArchivedPathRows, managedDbContainer } from '../../lib/backup/archive-layout';

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

test('verify refuses two trash roots that were each trashed from inside the other', () => {
    const root = row('root', 'Drive', 'folder', null);
    const a = { ...row('a', 'A', 'folder', root.id), trashedFrom: 'inB' };
    const inA = row('inA', 'In A', 'folder', a.id);
    const b = { ...row('b', 'B', 'folder', root.id), trashedFrom: 'inA' };
    const inB = row('inB', 'In B', 'folder', b.id);
    expect(checkArchivedPathRows([root, a, inA, b, inB])).toEqual([
        'path row a was trashed from inside itself',
        'path row b was trashed from inside itself',
    ]);
});

test('verify passes trash roots trashed from a live folder and from inside another trash root', () => {
    const root = row('root', 'Drive', 'folder', null);
    const live = row('live', 'Live', 'folder', root.id);
    const a = { ...row('a', 'A', 'folder', root.id), trashedFrom: live.id };
    const inA = row('inA', 'In A', 'folder', a.id);
    const b = { ...row('b', 'B', 'file', root.id), trashedFrom: inA.id };
    expect(checkArchivedPathRows([root, live, a, inA, b])).toEqual([]);
});

// A live delete of a folder can leave a trash root trashed from it, and a restore sends that one to the root.
test('verify passes a trash root whose original folder is gone', () => {
    const root = row('root', 'Drive', 'folder', null);
    const orphan = { ...row('orphan', 'Orphan', 'file', root.id), trashedFrom: 'deleted-folder' };
    expect(checkArchivedPathRows([root, orphan])).toEqual([]);
});

test('verify names only the trash roots on the loop, not one trashed from inside it', () => {
    const root = row('root', 'Drive', 'folder', null);
    const a = { ...row('a', 'A', 'folder', root.id), trashedFrom: 'inB' };
    const inA = row('inA', 'In A', 'folder', a.id);
    const b = { ...row('b', 'B', 'folder', root.id), trashedFrom: 'inA' };
    const inB = row('inB', 'In B', 'folder', b.id);
    const c = { ...row('c', 'C', 'file', root.id), trashedFrom: inA.id };
    expect(checkArchivedPathRows([c, root, a, inA, b, inB])).toEqual([
        'path row a was trashed from inside itself',
        'path row b was trashed from inside itself',
    ]);
});
