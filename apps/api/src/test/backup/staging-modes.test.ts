import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getBackupStagingDir, getStagingRoot, wipeBackupStagingDir } from '../../lib/backup/paths';
import { pullHomeSnapshot } from '../../lib/home/home-relay';
import type { TestContext } from '../setup';
import { getTestContext, TEST_DATA_DIR } from '../setup';

// A job stages a home unpacked, auth rows and every file, inside backups/, which the operator's group lists because
// ./eigen reads it. The staging root and each job's folder are the API's user's alone, so what a job
// writes there is out of reach of other users on the host while it runs, whatever the umask gives each file.
describe('Backup staging modes', () => {
    const backupsDir = join(TEST_DATA_DIR, 'backups-staging-modes');
    let ctx: TestContext;
    let previousBackupsDir: string | undefined;
    let previousUmask: number;

    const modeOf = (target: string): number => statSync(target).mode & 0o777;

    // Whether a user other than the API's reads `file`, as one of its group or as anybody: the file's own
    // read bit, and the search bit of every folder from the backups folder down to it.
    function readableByOthers(file: string): boolean {
        return [
            { read: 0o040, search: 0o010 },
            { read: 0o004, search: 0o001 },
        ].some(({ read, search }) => {
            if ((modeOf(file) & read) === 0) return false;
            for (let dir = dirname(file); dir.startsWith(backupsDir); dir = dirname(dir)) {
                if ((modeOf(dir) & search) === 0) return false;
            }
            return true;
        });
    }

    function filesUnder(dir: string): string[] {
        return readdirSync(dir, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => join(entry.parentPath, entry.name));
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        previousBackupsDir = process.env['EIGEN_BACKUPS_DIR'];
        process.env['EIGEN_BACKUPS_DIR'] = backupsDir;
        // The umask a host operator usually has, which leaves every new file 0644 and every folder 0755.
        previousUmask = process.umask(0o022);
    });

    afterAll(() => {
        process.umask(previousUmask);
        if (previousBackupsDir === undefined) delete process.env['EIGEN_BACKUPS_DIR'];
        else process.env['EIGEN_BACKUPS_DIR'] = previousBackupsDir;
        rmSync(backupsDir, { recursive: true, force: true });
    });

    test("a capture's staged files are the API's user's alone, and backups/ stays listable", async () => {
        const jobId = 'staging-modes-capture';
        const staging = getBackupStagingDir(jobId);
        try {
            await pullHomeSnapshot(ctx.alice.user.id, staging, {});
            expect(modeOf(getStagingRoot())).toBe(0o700);
            expect(modeOf(staging)).toBe(0o700);
            const staged = filesUnder(staging);
            expect(staged.map((file) => file.slice(staging.length))).toContainEqual(
                expect.stringMatching(/\/auth\.json$/),
            );
            expect(staged.filter(readableByOthers)).toEqual([]);
            expect(modeOf(backupsDir)).toBe(0o755);
        } finally {
            await wipeBackupStagingDir(jobId);
        }
    }, 60_000);

    // The launcher gives backups/ the operator's group with the setgid bit, so a folder made in it takes that group,
    // and on Linux the bit too. Folders staged under it go into data/, which must get neither.
    test('a setgid backups/ passes no setgid bit into staging', () => {
        const fullModeOf = (target: string): number => statSync(target).mode & 0o7777;
        mkdirSync(backupsDir, { recursive: true });
        chmodSync(backupsDir, 0o2750);
        try {
            // What a mkdir in backups/ makes on Linux. macOS ignores the bit on a folder, so it is set by hand.
            rmSync(getStagingRoot(), { recursive: true, force: true });
            mkdirSync(getStagingRoot(), { mode: 0o700 });
            chmodSync(getStagingRoot(), 0o2700);
            const staging = getBackupStagingDir('staging-modes-setgid');
            expect(fullModeOf(getStagingRoot())).toBe(0o700);
            expect(fullModeOf(staging)).toBe(0o700);
            expect(fullModeOf(backupsDir)).toBe(0o2750);
        } finally {
            chmodSync(backupsDir, 0o755);
        }
    });
});
