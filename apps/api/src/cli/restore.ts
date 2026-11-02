// The restore command of the eigen launcher, which puts a whole-server archive back. It picks the mode from the
// flags: the stage unpacks and checks the archive while Eigen runs, and the swap moves it in with Eigen stopped.
// It also holds the two small modes. --env takes a fresh machine's .env.production from the archive, and
// --check-data is the check a rollback runs with the build it goes back to, on today's data: first while Eigen runs,
// then with --since once Eigen is stopped.

import { chmodSync, existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { parseArgs } from 'node:util';
import { HOME_DATABASES } from '../lib/backup/archive-layout';
import { describeError } from '../lib/backup/errors';
import type { VersionedDatabase } from '../lib/backup/materialize-mount';
import {
    checkDatabases,
    containerDatabasesIn,
    mountIdsIn,
    quickCheck,
    UnopenableDatabaseError,
} from '../lib/backup/materialize-mount';
import {
    isRestoreStagingName,
    parseSafetyCopyName,
    requireMountDir,
    SERVER_ARCHIVE_ENV_MEMBER,
} from '../lib/backup/paths';
import { RESTORING_DIR } from '../lib/backup/restore-server';
import { readServerArchiveMember } from '../lib/backup/verify-server-archive';
import { HOMES_DIRS, PATHS, SERVER_DATABASES, SERVER_DIR } from '../lib/config/paths';
import { API_IMAGE_KEY } from '../lib/config/release';
import { MOUNT_DB_CONFIG } from '../lib/mount/db-config';
import { SHARE_REGISTRY_DB_CONFIG } from '../lib/share/db-config';
import { WAITLIST_DB_CONFIG } from '../lib/waitlist/db-config';
import { readEnvFile } from './env-file';
import { CANNOT_OPEN, DATA, DECLINED, ENV_PATH, installOwner, ownAs, VERSION } from './install';
import { stage } from './restore-stage';
import { printStaged, swap } from './restore-swap';
import { createUi, glyphLine, refuseUsage } from './ui';

// --stage runs as the API's user in its container while Eigen runs, so it works on the data root, .env.production
// and backups folder the API sees. The other modes work on the install folder (-w /install): --check-data as the
// API's user, and --swap, --staged and --env as root.
export const RESTORE_OPTIONS = {
    stage: { type: 'boolean' },
    staged: { type: 'boolean' },
    swap: { type: 'boolean' },
    env: { type: 'boolean' },
    'check-data': { type: 'boolean' },
    since: { type: 'string' },
    yes: { type: 'boolean' },
    's3-from-archive': { type: 'boolean' },
} as const;
export const RESTORE_USAGE = `Usage: restore <archive> --stage [--yes] [--s3-from-archive]
       restore --staged
       restore --swap
       restore <archive> --env
       restore --check-data [--yes] [--since <ms>]

Puts a whole-server archive back in two steps, run by ./eigen restore.

  --stage            Unpack and check <archive> (a name in backups/ or a path) into data/${RESTORING_DIR} while
                     Eigen runs. Asks first; a no, or a refusal, leaves data/ as it is
  --yes              Do not ask
  --s3-from-archive  Upload the files an archive with S3 files holds under fresh keys, instead of keeping the
                     bucket as it is
  --staged           Print the staged archive's version and the images its ${ENV_PATH} pins
  --swap             With Eigen stopped: swap the staged tree in and keep what it replaces aside. Finishes a swap
                     that was cut off
  --env              On a fresh machine, before the stage: write the ${ENV_PATH} of <archive> here, which pins
                     the build that restores it
  --check-data       While Eigen runs, as the API's user: check that this build opens every database in data/ as
                     it is, then ask to go back to it. ./eigen rollback runs it with the build it goes back to
  --since <ms>       With --check-data: check only the databases written at or after this time, in ms since 1970.
                     ./eigen rollback checks again with it once Eigen is stopped`;

export type RestoreFlags = ReturnType<typeof parseArgs<{ options: typeof RESTORE_OPTIONS }>>['values'];

export async function restore(archive: string | undefined, flags: RestoreFlags): Promise<void> {
    const modes = [flags.stage, flags.staged, flags.swap, flags.env, flags['check-data']].filter(Boolean).length;
    if (modes !== 1 || (!flags.stage && !flags.env && archive !== undefined)) {
        return refuseUsage(
            'Pass one of --stage, --staged, --swap, --env or --check-data; only --stage and --env take an archive.',
            RESTORE_USAGE,
        );
    }
    if (flags.since !== undefined && !flags['check-data']) {
        return refuseUsage('Only --check-data takes --since.', RESTORE_USAGE);
    }
    if (flags.env) return writeArchiveEnv(archive);
    if (flags['check-data']) return checkData(flags);
    if (flags.stage) return stage(archive, flags);
    if (flags.staged) return printStaged();
    return swap();
}

// No setup runs on a fresh machine: the archive's own file pins the images, Compose's settings and the secrets, and
// setup would write an org the restore throws away.
async function writeArchiveEnv(archive: string | undefined): Promise<void> {
    const ui = await createUi(true);
    if (!archive) return ui.fail('Name the archive to restore.', 'Pass the path of a server archive.');
    const name = basename(archive);
    if (existsSync(ENV_PATH)) {
        return ui.fail(`This folder has a ${ENV_PATH} already.`, `./eigen restore restores ${name} onto it.`);
    }
    const read = await readServerArchiveMember(archive, SERVER_ARCHIVE_ENV_MEMBER);
    if ('failure' in read) {
        return ui.fail(`${name} is not a whole Eigen server archive: ${read.failure}.`, 'Restore another archive.');
    }
    if (!read.bytes) {
        return ui.fail(
            `${name} holds no ${ENV_PATH}, so it cannot be restored on a fresh machine.`,
            'Run ./eigen setup first, then ./eigen restore.',
        );
    }
    const temporary = `${ENV_PATH}.${process.pid}.tmp`;
    try {
        writeFileSync(temporary, read.bytes, { mode: 0o600 });
    } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
    if (!readEnvFile(temporary).has(API_IMAGE_KEY)) {
        rmSync(temporary);
        return ui.fail(
            `${name} is an archive of a local build, which pins no images.`,
            'Restore it in a clone of Eigen, after ./eigen setup.',
        );
    }
    chmodSync(temporary, 0o600);
    ownAs(temporary, installOwner('.'));
    renameSync(temporary, ENV_PATH);
    console.log(glyphLine('ok', `Took ${ENV_PATH} from ${name}`));
}

// A rollback keeps today's data when the build it goes back to opens it, and puts the update's backup back otherwise.
// This checks, with that build and before the switch, that it opens that data. Every home of every kind gets the
// verdict a restore ends on, and the server's versioned databases and users3.db are checked too. It skips the safety
// copies and the folder a killed restore staged, which no home opens, and the container databases of an s3 mount,
// which live in the bucket. Only a database that fails its check, or is newer than this build, exits CANNOT_OPEN: a
// check that could not run says nothing of the data, so it must not send the rollback to the backup.
async function checkData(flags: RestoreFlags): Promise<void> {
    const ui = await createUi(flags.yes === true);
    const changed = changedSince(flags.since);
    const server = join(DATA, SERVER_DIR);
    try {
        await checkDatabases(
            [
                { filePath: join(server, SERVER_DATABASES.shares), config: SHARE_REGISTRY_DB_CONFIG },
                { filePath: join(server, SERVER_DATABASES.waitlist), config: WAITLIST_DB_CONFIG },
            ].filter(changed),
        );
        const users = join(server, SERVER_DATABASES.users);
        if (changed({ filePath: users })) checkPages(users);
        const homeDirs = HOMES_DIRS.map((dir) => join(DATA, dir))
            .filter(existsSync)
            .flatMap((homes) =>
                readdirSync(homes, { withFileTypes: true })
                    .filter(
                        (entry) =>
                            entry.isDirectory() &&
                            !parseSafetyCopyName(entry.name) &&
                            !isRestoreStagingName(entry.name),
                    )
                    .map((entry) => join(homes, entry.name)),
            );
        // A large server takes minutes, so each home gets a line.
        for (const [index, homeDir] of homeDirs.entries()) {
            console.log(glyphLine('bar', `home ${index + 1} of ${homeDirs.length}: ${homeDir}`));
            const mountIds = mountIdsIn(homeDir);
            // Each mount's metadata.db first, because the container databases are found by reading it.
            await checkDatabases(homeDatabases(homeDir, mountIds).filter(changed));
            await checkDatabases(containerDatabasesIn(homeDir, mountIds).filter(changed));
        }
    } catch (error) {
        console.error(glyphLine('bad', `${describeError(error)}.`));
        process.exit(error instanceof UnopenableDatabaseError ? CANNOT_OPEN : 1);
    }
    console.log(glyphLine('ok', 'This build opens every database in data/'));
    if (flags.yes) return;
    const go = await ui.confirm({
        message: `Go back to Eigen ${VERSION}, keeping the data as it is? Eigen stops for the switch.`,
        initial: false,
        flag: '--yes',
    });
    if (!go) {
        ui.outro('Nothing was changed.');
        process.exit(DECLINED);
    }
}

// With --since, a time in ms, only the databases written at or after it are checked. The rollback checks again once
// Eigen is stopped, and only what Eigen wrote after the first check began can have changed. A write may be in the
// -wal alone.
function changedSince(since: string | undefined): (database: { filePath: string }) => boolean {
    if (since === undefined) return () => true;
    if (!/^\d+$/.test(since)) return refuseUsage(`--since takes a time in ms, not "${since}".`, RESTORE_USAGE);
    const after = Number(since);
    return ({ filePath }) =>
        [filePath, `${filePath}-wal`].some(
            (file) => (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) >= after,
        );
}

// users3.db has no schema version to compare, so only its pages are checked. The API runs beside this check, and its
// journal locks out readers while a sign-in writes, so that writer is waited out as for every other database.
function checkPages(filePath: string): void {
    if (!existsSync(filePath)) return;
    const verdict = quickCheck(filePath);
    if (verdict !== 'ok') throw new UnopenableDatabaseError(500, `${filePath} is damaged: ${verdict}`);
}

// The databases checkRestoredDatabases checks first in a home: its own, and each mount's metadata.db.
function homeDatabases(homeDir: string, mountIds: readonly string[]): VersionedDatabase[] {
    return [
        ...HOME_DATABASES.map(([config, relPath]) => ({ filePath: join(homeDir, relPath), config })),
        ...mountIds.map((mountId) => ({
            filePath: join(requireMountDir(homeDir, mountId), PATHS.DRIVE.METADATA_DB),
            config: MOUNT_DB_CONFIG,
        })),
    ];
}
