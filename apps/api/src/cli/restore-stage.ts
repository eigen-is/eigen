// The stage of ./eigen restore, which runs as the API's user beside the running API. It checks a whole-server
// archive, says what it holds and asks, then unpacks it into data/.restoring through stageServerArchive. It writes
// the staged record last, and only that record tells the swap there is something to swap in.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { formatDate, formatTimeAgo } from '@workspace/lib/date';
import { LIGHT_SERVER_ARCHIVE } from '@workspace/lib/validation';
import { copyArchiveMember } from '../lib/backup/archive';
import { describeError } from '../lib/backup/errors';
import { backupsDirPath, roomShortfall, SERVER_ARCHIVE_ENV_MEMBER } from '../lib/backup/paths';
import type { ServerArchiveFile } from '../lib/backup/restore-server';
import { RESTORING_DIR, readMemberManifests, stageBytesNeeded, stageServerArchive } from '../lib/backup/restore-server';
import { describeFailures } from '../lib/backup/verify';
import { readServerArchive } from '../lib/backup/verify-server-archive';
import { getEnvFile, isMailEnabled } from '../lib/config/env';
import { getDataRoot } from '../lib/config/paths';
import { readEnvFile } from './env-file';
import { DECLINED, ENV_PATH, VERSION } from './install';
import type { RestoreFlags } from './restore';
import type { StagedRestore } from './restore-swap';
import { holdLock, STAGE_RECORD } from './restore-swap';
import { createUi, glyphLine } from './ui';

// In data/.restoring, held by the stage that fills it: a second one would wipe its tree.
const STAGE_LOCK = 'stage.lock';

export async function stage(archive: string | undefined, flags: RestoreFlags): Promise<void> {
    const ui = await createUi(flags.yes === true);
    if (!archive) return ui.fail('Name the archive to restore.', 'Pick a server archive in backups/.');
    const archivePath = archive.includes('/') ? archive : join(backupsDirPath(), archive);
    if (!statSync(archivePath, { throwIfNoEntry: false })?.isFile()) {
        return ui.fail(`${archive} is not a file.`, 'Name a server archive in backups/, or its path.');
    }
    const name = basename(archivePath);
    if (LIGHT_SERVER_ARCHIVE.test(name)) {
        return ui.fail(
            `${name} is a Light backup, which this version of Eigen no longer restores.`,
            'Restore a Full one.',
        );
    }
    const dataRoot = getDataRoot();
    const restoring = join(dataRoot, RESTORING_DIR);
    mkdirSync(restoring, { recursive: true, mode: 0o700 });
    if (!holdLock(join(restoring, STAGE_LOCK))) {
        return ui.fail(
            'Another restore is staging into data/.restoring.',
            'Wait for it to finish, then run ./eigen restore again.',
        );
    }
    // A stage that died halfway left its tree here, with no record: it goes, whatever it holds.
    for (const entry of readdirSync(restoring)) {
        if (entry !== STAGE_LOCK) rmSync(join(restoring, entry), { recursive: true, force: true });
    }
    const refuse = (message: string, next: string): never => {
        rmSync(restoring, { recursive: true, force: true });
        return ui.fail(message, next);
    };
    const decline = (): never => {
        rmSync(restoring, { recursive: true, force: true });
        ui.outro('Nothing was changed.');
        return process.exit(DECLINED);
    };

    const read = await readServerArchive(archivePath);
    const manifest = read.manifest;
    if (!manifest) {
        return refuse(
            `${name} is not an Eigen server archive: ${read.verify.failures[0]}.`,
            'Restore an archive made by ./eigen backup.',
        );
    }
    if (read.verify.status !== 'verified') {
        return refuse(`${name} is damaged: ${describeFailures(read.verify)}.`, 'Restore another archive.');
    }
    if (isNewerBuild(manifest.appVersion, VERSION)) {
        return refuse(
            `${name} is an archive of Eigen ${manifest.appVersion}; this install runs ${VERSION}.`,
            'Update first, then restore.',
        );
    }
    if (flags['s3-from-archive'] && manifest.level !== 'full-s3') {
        return refuse(
            `${name} holds no files of S3 buckets, so --s3-from-archive has nothing to upload.`,
            'Leave the flag out.',
        );
    }
    const archived: ServerArchiveFile = {
        name,
        manifest,
        members: new Map(read.members.map((member) => [member.name, member])),
    };
    // Each member's manifest is its last entry, so a read of one decompresses the whole member. They are read once,
    // for the room check and for the bound of each unpack.
    const manifests = await readMemberManifests(archived).catch((error) =>
        refuse(`${name} cannot be restored: ${describeError(error)}.`, 'Restore another archive.'),
    );
    const needed = await stageBytesNeeded(archived, manifests);
    const shortfall = roomShortfall(`Staging ${name}`, needed, dataRoot, 'data/');
    if (shortfall) return refuse(`${shortfall}.`, 'Free space on that disk, then run ./eigen restore again.');

    // An archive without .env.production keeps the one here; with neither, there is nothing to start Eigen with.
    const envMember = archived.members.get(SERVER_ARCHIVE_ENV_MEMBER);
    const current = getEnvFile();
    const hasCurrent = current !== undefined && existsSync(current);
    // The one Eigen runs with once restored.
    const envFile = envMember ? join(restoring, ENV_PATH) : hasCurrent ? current : undefined;
    if (!envFile) {
        return refuse(`${name} holds no ${ENV_PATH}, and this install has none.`, `Restore an archive that holds one.`);
    }
    if (envMember) await copyArchiveMember(envMember, envFile);
    // A release install runs the images its .env.production pins; a local build builds its own and pins none.
    if (envMember && hasCurrent) {
        const install = (env: string) =>
            readEnvFile(env).has('EIGEN_VERSION') ? 'a release install' : 'a local build';
        const [theirs, ours] = [install(envFile), install(current)];
        if (theirs !== ours) {
            return refuse(
                `${name} is an archive of ${theirs}; this is ${ours}.`,
                `Restore it on ${theirs} of Eigen, or restore an archive made here.`,
            );
        }
    }

    const homes = manifest.homes.filter((home) => home.member);
    const failed = manifest.homes.flatMap((home) => (home.failed ? [`${home.name} (${home.failed})`] : []));
    const warned = manifest.homes.flatMap((home) =>
        home.warnings?.length ? [`${home.name} (${home.warnings[0]})`] : [],
    );
    const lines = [
        `A ${manifest.level} archive of Eigen ${manifest.appVersion} for ${manifest.domain}, made on ${formatDate(manifest.createdAt)}, ${formatTimeAgo(manifest.createdAt)}`,
        `${homes.length} homes${failed.length ? `; not in it: ${failed.join(', ')}` : ''}${warned.length ? `; with warnings: ${warned.join(', ')}` : ''}`,
        envMember ? `${ENV_PATH} from the archive` : `No ${ENV_PATH}: the one here stays`,
    ];
    // With mail off, Eigen reads neither the DKIM key nor the mail TLS certificate.
    if (isMailEnabled(Object.fromEntries(readEnvFile(envFile)))) {
        lines.push(
            manifest.dkim ? 'The DKIM key from the archive' : 'No DKIM key: the one here stays, or mail needs new DNS',
            manifest.certs
                ? 'The mail TLS certificate from the archive'
                : 'No mail TLS certificate: the one here stays, or the mail server makes a self-signed one',
        );
    }
    ui.note(name, lines);
    if (!flags.yes) {
        const go = await ui.confirm({
            message: `Stage ${name}? Eigen keeps running; data/ is swapped only once it is staged.`,
            initial: false,
            flag: '--yes',
        });
        if (!go) decline();
    }

    const staged = await stageServerArchive(archived, restoring, {
        s3FromArchive: flags['s3-from-archive'] === true,
        onStep: (step) => console.log(glyphLine('bar', step)),
        manifests,
    }).catch((error) => refuse(`${name} cannot be restored: ${describeError(error)}.`, 'Restore another archive.'));
    const record: StagedRestore = { archive: name, appVersion: manifest.appVersion };
    writeFileSync(join(restoring, STAGE_RECORD), JSON.stringify(record));
    console.log(glyphLine('ok', `Staged ${name} in data/${RESTORING_DIR}`));
    if (staged.settled) {
        console.log(
            glyphLine(
                'warn',
                `${staged.settled} pending upload(s) in the archive are not replayed: data/ here already uploaded them`,
            ),
        );
    }
    if (staged.missing) {
        console.log(
            glyphLine(
                'warn',
                `${staged.missing} pending upload(s) are not replayed: the archive does not hold their bytes`,
            ),
        );
    }
}

// Whether Eigen `appVersion`, such as the build an archive was made by, is newer than `version`. Its databases may then
// carry a schema that `version` cannot open. The stage does not check every one of them, as the documents of an s3
// mount that stays on its bucket are never read, so it refuses such an archive. What is not a version counts as newer:
// Bun.semver.order throws on it.
function isNewerBuild(appVersion: string, version: string): boolean {
    try {
        return Bun.semver.order(appVersion, version) > 0;
    } catch {
        return true;
    }
}
