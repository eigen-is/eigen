import { Database } from 'bun:sqlite';
import { expect, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupJob, BackupLevel, BackupManifest, BackupReason } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import { SERVER_ARCHIVE_PREFIX } from '@workspace/lib/validation';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { getBackupJob } from '../../lib/backup/jobs';
import { buildHomeFolderName, getBackupsDir, serverSidecarPath } from '../../lib/backup/paths';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { readServerArchive } from '../../lib/backup/verify';
import { getDomain } from '../../lib/config/server-config';
import { type DatabaseConfig, PATHS } from '../../lib/core';
import type { Home } from '../../lib/home';
import { getHome } from '../../lib/home/get-home';
import * as homeRelay from '../../lib/home/home-relay';
import {
    assertJson,
    authedRequest,
    createTestUserOnStorage,
    drivePost,
    driveUpload,
    TEST_DATA_DIR,
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

// The server archives and records in the backups folder, which the whole run shares.
export function serverRecords(): string[] {
    return readdirSync(getBackupsDir()).filter((name) => name.startsWith(SERVER_ARCHIVE_PREFIX));
}

export function removeServerRecords(): void {
    for (const name of serverRecords()) rmSync(join(getBackupsDir(), name), { force: true });
}

// A record the way a finished or refused attempt leaves one, without running a job, and the archive's bytes if given.
export function writeServerRecord(name: string, record: object, archive?: string | Uint8Array): string {
    const archivePath = join(getBackupsDir(), name);
    if (archive !== undefined) writeFileSync(archivePath, archive);
    writeFileSync(serverSidecarPath(archivePath), JSON.stringify(record));
    return archivePath;
}

// The manifest of a server archive of one home, as a job writes it: whole, with the home failed, or with warnings.
export function serverManifestOf(reason: BackupReason, at: string, outcome: 'complete' | 'failed' | 'warned') {
    const home = { ownerId: 'a'.repeat(32), kind: 'user', name: 'alice' };
    const outcomes = {
        complete: home,
        failed: { ...home, failed: 'bucket unreachable' },
        warned: { ...home, member: 'homes/alice.tar.zst', warnings: ['mount default: a.png'] },
    };
    return {
        formatVersion: 1,
        level: 'full',
        reason,
        createdAt: at,
        appVersion: 'test',
        domain: getDomain(),
        entries: outcome === 'warned' ? [{ path: 'homes/alice.tar.zst', bytes: 1, sha256: 'a'.repeat(64) }] : [],
        homes: [outcomes[outcome]],
        orphans: [],
        envFile: true,
        dkim: true,
        certs: true,
        images: {},
    };
}

// The manifest and members of a server archive that reads.
export async function readServerManifest(archivePath: string) {
    const { manifest, members } = await readServerArchive(archivePath);
    if (!manifest) throw new Error(`${archivePath} carries no server manifest`);
    return { manifest, members };
}

// Holds every home capture until released, so a job stays running while a test looks at it.
export function holdCaptures(): { release(): void; restore(): void } {
    const gate = Promise.withResolvers<void>();
    const pull = homeRelay.pullHomeSnapshot;
    const spy = spyOn(homeRelay, 'pullHomeSnapshot').mockImplementation(async (...args) => {
        await gate.promise;
        return pull(...args);
    });
    return {
        release: () => gate.resolve(),
        restore: () => {
            gate.resolve();
            spy.mockRestore();
        },
    };
}

// A container database of one table, a row per marker, so which copy a capture took reads back by its markers. No
// snapshot config: a close-time version would be noise.
export const MARKER_SCHEMA = { items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }) };
export const MARKER_DB_CONFIG: DatabaseConfig<typeof MARKER_SCHEMA> = {
    name: 'backup-marker-doc',
    currentVersion: 1,
    schema: MARKER_SCHEMA,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

export function readMarkers(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
        return db
            .query<{ data: string }, []>('SELECT data FROM items ORDER BY id')
            .all()
            .map((row) => row.data);
    } finally {
        db.close();
    }
}

// One capture of `home` into a folder of its own.
export async function snapshotInto(
    home: Home,
    level?: BackupLevel,
): Promise<{ manifest: BackupManifest; folder: string }> {
    const target = mkdtempSync(join(TEST_DATA_DIR, `backup-snapshot-${level ?? 'default'}-`));
    const manifest = await snapshotHome(home, target, { level });
    return { manifest, folder: join(target, buildHomeFolderName(home.user.id)) };
}

// The titles of the admin alerts sendToHome was handed for `ownerId`.
export function alertTitlesTo(
    spy: { mock: { calls: Parameters<typeof homeRelay.sendToHome>[] } },
    ownerId: string,
): string[] {
    return spy.mock.calls.flatMap(([target, message]) =>
        target === ownerId && message.type === 'notification' && message.notification.type === 'admin-alert'
            ? [message.notification.title]
            : [],
    );
}

// A home the way installs have them: the default mount stores files by name (local-fullnames, the install default;
// the suite's own default is local-id), with what a user leaves behind in a few months: a nested folder, a renamed
// file, a trashed file, a trashed folder with a child, a trashed document and a document with a saved version.
export type RealShapeHome = {
    user: TestUser;
    // Storage key under the mount's data/ to the bytes a restore must put back there.
    files: Record<string, string>;
    // Storage keys of the databases a restore must put back.
    databases: string[];
    // The renamed file, the trashed file and the versioned document, for reads through the API.
    ids: { renamed: string; trashed: string; versioned: string };
};

const MOUNT_ID = 'default';
const mountData = (homeDir: string) => join(homeDir, PATHS.DRIVE.ROOT, MOUNT_ID, PATHS.DRIVE.DATA_DIR);

async function trash(user: TestUser, pathId: string): Promise<void> {
    const res = await authedRequest(user.sessionToken, `/drive/${user.id}/${MOUNT_ID}/path/${pathId}`, {
        method: 'DELETE',
    });
    expect(res.status).toBe(200);
}

export async function realShapeHome(): Promise<RealShapeHome> {
    const user = await createTestUserOnStorage('local-fullnames', 'Real Shape');
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

    const { homeDir } = await getHome(user.id);
    const [version] = readdirSync(join(mountData(homeDir), 'Versioned.eigendoc/versions')).sort();
    const shape: RealShapeHome = {
        user,
        files: {
            'Projects/2026/final.txt': 'renamed bytes',
            [`.trash/${trashedFile.id}.txt`]: 'trashed bytes',
            [`.trash/${trashedFolder.id}/child.txt`]: 'child bytes',
        },
        databases: [`.trash/${trashedDoc.id}.eigendoc/data.db`, `Versioned.eigendoc/versions/${version}`],
        ids: { renamed: renamed.id, trashed: trashedFile.id, versioned: versioned.id },
    };
    // Against the live mount's disk, so the fixture cannot encode the capture's own assumption.
    expectRealShape(homeDir, shape);
    return shape;
}

// Every byte of the fixture where the mount looks for it, in the home folder `homeDir`.
export function expectRealShape(homeDir: string, shape: RealShapeHome): void {
    const data = mountData(homeDir);
    for (const [key, body] of Object.entries(shape.files)) expect(readFileSync(join(data, key), 'utf8')).toBe(body);
    for (const key of shape.databases) expect(existsSync(join(data, key))).toBe(true);
}

// The restored fixture as its user meets it: the trash lists its three items, the renamed file downloads, the
// trashed one restores and downloads, and the document lists its version.
export async function expectRealShapeServed({ user, ids }: RealShapeHome): Promise<void> {
    const drive = (path: string, init?: RequestInit) =>
        authedRequest(user.sessionToken, `/drive/${user.id}/${MOUNT_ID}/${path}`, init);
    const trash = await assertJson<DrivePath[]>(await drive('trash'));
    expect(trash.map((item) => item.name).sort()).toEqual(['Old', 'Trashed Doc.eigendoc', 'trashed.txt']);
    expect(await (await drive(`file/${ids.renamed}/download`)).text()).toBe('renamed bytes');
    expect((await drive(`trash/${ids.trashed}/restore`, { method: 'POST' })).status).toBe(200);
    expect(await (await drive(`file/${ids.trashed}/download`)).text()).toBe('trashed bytes');
    expect(await assertJson<unknown[]>(await drive(`file/${ids.versioned}/versions`))).toHaveLength(1);
}
