// A backup copies the databases a mount manages under the lock of their document, and every other file byte for
// byte. A document's versions folder is found the way every lookup finds it, whatever the case of its name.
import { expect, test } from 'bun:test';
import type { DrivePathType } from '@workspace/lib/types/drive';
import type { MountPathRow } from '../../lib/backup/archive-layout';
import { managedDbContainer } from '../../lib/backup/archive-layout';

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
