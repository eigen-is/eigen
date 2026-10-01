import { Database } from 'bun:sqlite';
import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { runHomeBackup, startBackupJob } from '../../lib/backup/jobs';
import { restoreHome } from '../../lib/backup/restore';
import { verifyFolder } from '../../lib/backup/verify';
import { getStorageType, updateServerSettings } from '../../lib/config/server-settings';
import { getHome } from '../../lib/home/get-home';
import { Mount } from '../../lib/mount/mount';
import {
    assertJson,
    authedRequest,
    createTestUser,
    driveDelete,
    driveGetList,
    drivePost,
    drivePut,
    driveUpload,
    ensureServer,
    type TestUser,
} from '../setup';
import { snapshotInto, waitForJob } from './backup-test-helpers';

const M = 'default';
const REPORTS = [0, 1, 2, 3, 4];

async function raceUser(storageType: 'local-fullnames' | 'local-id'): Promise<TestUser> {
    await ensureServer();
    const before = getStorageType();
    await updateServerSettings({ defaults: { mount: { storageType } } });
    try {
        const user = await createTestUser(`race-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Race');
        await getHome(user.id);
        return user;
    } finally {
        await updateServerSettings({ defaults: { mount: { storageType: before } } });
    }
}

async function seed(user: TestUser) {
    const t = user.sessionToken;
    const root = await assertJson<DrivePath>(await authedRequest(t, `/drive/${user.id}/${M}/root`));
    const projects = await drivePost(t, user.id, M, `folder/${root.id}`, { folderName: 'Projects' });
    for (const i of REPORTS)
        await driveUpload(t, user.id, M, projects.id, new File([`report ${i}`], `report-${i}.txt`));
    const single = await driveUpload(t, user.id, M, root.id, new File(['single'], 'zz-single.txt'));
    const archive = await drivePost(t, user.id, M, `folder/${root.id}`, { folderName: 'Archive' });
    return { projects, single, archive };
}

// The user's action starts right before the capture reads its first plain file and runs to its end, or until it
// waits for the tree lock the capture holds: awaiting it there would wait on the capture itself.
function duringCapture(action: () => Promise<unknown>) {
    const readKey = Mount.prototype.readKey;
    const withTreeExclusive = Mount.prototype.withTreeExclusive;
    const queued = Promise.withResolvers<void>();
    let done: Promise<unknown> = Promise.resolve();
    let fired = false;
    const exclusive = spyOn(Mount.prototype, 'withTreeExclusive').mockImplementation(function <T>(
        this: Mount,
        fn: () => Promise<T>,
    ) {
        queued.resolve();
        return withTreeExclusive.bind(this)(fn);
    });
    const read = spyOn(Mount.prototype, 'readKey').mockImplementation(async function (this: Mount, key: string) {
        if (!fired) {
            fired = true;
            done = action();
            await Promise.race([done, queued.promise]);
        }
        return readKey.call(this, key);
    });
    return {
        settled: () => done,
        restore: () => {
            read.mockRestore();
            exclusive.mockRestore();
        },
    };
}

async function captureDuring(user: TestUser, action: () => Promise<unknown>) {
    const race = duringCapture(action);
    try {
        const result = await snapshotInto(await getHome(user.id), 'full');
        await race.settled();
        return result;
    } finally {
        race.restore();
    }
}

// The archived rows' own paths: the archive holds a file's bytes where its archived row says it is.
function archivedReports(folder: string): string[] {
    const data = join(folder, 'home/mounts', M, 'data');
    return REPORTS.map((i) => readFileSync(join(data, 'Projects', `report-${i}.txt`), 'utf8'));
}

function archivedRow(folder: string, id: string) {
    const db = new Database(join(folder, 'home/mounts', M, 'metadata.db'), { readonly: true });
    try {
        return db.query<{ name: string }, [string]>('SELECT name FROM paths WHERE id = ?').get(id);
    } finally {
        db.close();
    }
}

const reportBodies = REPORTS.map((i) => `report ${i}`);

describe('a capture on a by-name mount takes a file the user moves meanwhile', () => {
    test('a folder renamed during the capture', async () => {
        const user = await raceUser('local-fullnames');
        const { projects } = await seed(user);
        const { folder } = await captureDuring(user, () =>
            drivePut(user.sessionToken, user.id, M, `path/${projects.id}/rename`, { newName: 'Projects 2026' }),
        );
        expect(archivedRow(folder, projects.id)?.name).toBe('Projects');
        expect(archivedReports(folder)).toEqual(reportBodies);
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    test('a folder moved during the capture', async () => {
        const user = await raceUser('local-fullnames');
        const { projects, archive } = await seed(user);
        const { folder } = await captureDuring(user, () =>
            drivePut(user.sessionToken, user.id, M, `path/${projects.id}/move`, { targetParentId: archive.id }),
        );
        expect(archivedReports(folder)).toEqual(reportBodies);
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    test('a file trashed during the capture', async () => {
        const user = await raceUser('local-fullnames');
        const { single } = await seed(user);
        const { folder } = await captureDuring(user, () =>
            driveDelete(user.sessionToken, user.id, M, `path/${single.id}`),
        );
        expect(readFileSync(join(folder, 'home/mounts', M, 'data/zz-single.txt'), 'utf8')).toBe('single');
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    test('a file deleted for good during the capture is left out, its archived row with no bytes', async () => {
        const user = await raceUser('local-fullnames');
        const { single } = await seed(user);
        await driveDelete(user.sessionToken, user.id, M, `path/${single.id}`);
        const { manifest, folder } = await captureDuring(user, () =>
            driveDelete(user.sessionToken, user.id, M, `trash/${single.id}`),
        );
        expect(archivedRow(folder, single.id)?.name).toBe('zz-single.txt');
        expect(manifest.entries.some((entry) => entry.path.includes(single.id))).toBe(false);
        expect(archivedReports(folder)).toEqual(reportBodies);
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    test('a flat-key mount, whose keys a rename does not change, is captured as before', async () => {
        const user = await raceUser('local-id');
        const { projects } = await seed(user);
        const { folder } = await captureDuring(user, () =>
            drivePut(user.sessionToken, user.id, M, `path/${projects.id}/rename`, { newName: 'Projects 2026' }),
        );
        expect(archivedReports(folder)).toEqual(reportBodies);
    });

    test('a folder moved during a backup job reads back after the restore', async () => {
        const user = await raceUser('local-fullnames');
        const { projects, archive } = await seed(user);
        const race = duringCapture(() =>
            drivePut(user.sessionToken, user.id, M, `path/${projects.id}/move`, { targetParentId: archive.id }),
        );
        let job: Awaited<ReturnType<typeof waitForJob>>;
        try {
            job = await waitForJob(
                startBackupJob('backup', user.id, undefined, (s, p) => runHomeBackup(user.id, s, p)).id,
            );
            await race.settled();
        } finally {
            race.restore();
        }
        expect(job.state).toBe('done');
        await restoreHome(job.artifact!, user.id, `race-${Date.now()}`);
        const t = user.sessionToken;
        const reports = await driveGetList(t, user.id, M, `folder/${projects.id}`);
        expect(reports.map((report) => report.name).sort()).toEqual(REPORTS.map((i) => `report-${i}.txt`));
        for (const report of reports) {
            const res = await authedRequest(t, `/drive/${user.id}/${M}/file/${report.id}/download`);
            expect(res.status).toBe(200);
        }
    }, 120_000);
});
