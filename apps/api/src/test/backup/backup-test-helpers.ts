import { expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupJob } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getBackupJob } from '../../lib/backup/jobs';
import { getStorageType, updateServerSettings } from '../../lib/config/server-settings';
import { getHome } from '../../lib/home/get-home';
import {
    assertJson,
    authedRequest,
    createTestUser,
    drivePost,
    driveUpload,
    ensureServer,
    type TestUser,
} from '../setup';

export async function waitForJob(id: string): Promise<BackupJob> {
    for (let attempt = 0; attempt < 2400; attempt++) {
        const job = getBackupJob(id);
        if (job && job.state !== 'running') return job;
        await Bun.sleep(50);
    }
    throw new Error(`job ${id} did not finish`);
}

// A home the way installs have them: the default mount stores files by name (local-fullnames, the install default;
// the suite's own default is local-id), with what a user leaves behind in a few months: a nested folder, a renamed
// file, a trashed file, a trashed folder with a child, a trashed document and a document with a saved version.
export type RealShapeHome = {
    user: TestUser;
    mountId: string;
    // Storage key under the mount's data/ to the bytes a restore must put back there.
    files: Record<string, string>;
    // Storage keys of the databases a restore must put back.
    databases: string[];
};

const MOUNT_ID = 'default';

async function trash(user: TestUser, pathId: string): Promise<void> {
    const res = await authedRequest(user.sessionToken, `/drive/${user.id}/${MOUNT_ID}/path/${pathId}`, {
        method: 'DELETE',
    });
    expect(res.status).toBe(200);
}

export async function realShapeHome(): Promise<RealShapeHome> {
    await ensureServer();
    const storageType = getStorageType();
    await updateServerSettings({ defaults: { mount: { storageType: 'local-fullnames' } } });
    let user: TestUser;
    try {
        user = await createTestUser(`real-shape-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Real Shape');
        await getHome(user.id);
    } finally {
        await updateServerSettings({ defaults: { mount: { storageType } } });
    }
    const upload = (parentId: string, name: string, body: string) =>
        driveUpload<DrivePath>(user.sessionToken, user.id, MOUNT_ID, parentId, new File([body], name));
    const folder = (parentId: string, folderName: string) =>
        drivePost(user.sessionToken, user.id, MOUNT_ID, `folder/${parentId}`, { folderName });
    const doc = (fileName: string) =>
        drivePost(user.sessionToken, user.id, MOUNT_ID, `folder/${root.id}/create/doc`, { fileName });

    const root = await assertJson<DrivePath>(
        await authedRequest(user.sessionToken, `/drive/${user.id}/${MOUNT_ID}/root`),
    );
    const nested = await folder((await folder(root.id, 'Projects')).id, '2026');
    const renamed = await upload(nested.id, 'draft.txt', 'renamed bytes');
    const res = await authedRequest(user.sessionToken, `/drive/${user.id}/${MOUNT_ID}/path/${renamed.id}/rename`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: 'final.txt' }),
    });
    expect(res.status).toBe(200);

    const trashedFile = await upload(root.id, 'trashed.txt', 'trashed bytes');
    await trash(user, trashedFile.id);
    const trashedFolder = await folder(root.id, 'Old');
    await upload(trashedFolder.id, 'child.txt', 'child bytes');
    await trash(user, trashedFolder.id);
    const trashedDoc = await doc('Trashed Doc');
    await trash(user, trashedDoc.id);

    const versioned = await doc('Versioned');
    const saved = await authedRequest(
        user.sessionToken,
        `/drive/${user.id}/${MOUNT_ID}/file/${versioned.id}/versions/save`,
        { method: 'POST' },
    );
    expect(saved.status).toBe(200);

    const data = join((await getHome(user.id)).homeDir, 'mounts', MOUNT_ID, 'data');
    const [version] = readdirSync(join(data, 'Versioned.eigendoc/versions')).sort();
    const shape: RealShapeHome = {
        user,
        mountId: MOUNT_ID,
        files: {
            'Projects/2026/final.txt': 'renamed bytes',
            [`.trash/${trashedFile.id}.txt`]: 'trashed bytes',
            [`.trash/${trashedFolder.id}/child.txt`]: 'child bytes',
        },
        databases: [`.trash/${trashedDoc.id}.eigendoc/data.db`, `Versioned.eigendoc/versions/${version}`],
    };
    // The keys are the live mount's own, so the fixture is the shape trashPath and renamePath write today.
    expectRealShape(data, shape);
    return shape;
}

// Every byte of the fixture where the mount looks for it, under a mount's data/ folder.
export function expectRealShape(data: string, shape: RealShapeHome): void {
    for (const [key, body] of Object.entries(shape.files)) expect(readFileSync(join(data, key), 'utf8')).toBe(body);
    for (const key of shape.databases) expect(existsSync(join(data, key))).toBe(true);
}
