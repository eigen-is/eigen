import type { parseArgs } from 'node:util';
import { BACKUP_LEVEL_NAMES } from '@workspace/lib/constants/backup';
import { formatFileSize } from '@workspace/lib/format';
import { BACKUP_LEVELS, ON_DEMAND_BACKUP_REASONS } from '@workspace/lib/validation';
import type { ControlBackupJob } from '../lib/backup/server-job';
import { callControl } from './control-socket';
import { createUi, glyphLine } from './ui';

// Each step of a real server lasts seconds; a step shorter than this may go by unprinted.
const POLL_MS = 500;
// The archive is saved and good, only not in the bucket: cron can tell it from a backup that failed.
const NOT_UPLOADED = 4;

export const BACKUP_OPTIONS = {
    level: { type: 'string', default: 'full' },
    reason: { type: 'string', default: 'manual' },
    wait: { type: 'boolean' },
} as const;
export const BACKUP_USAGE = `Usage: backup [--level light|full|full-s3] [--reason manual|pre-update] [--wait]

Backs up the whole server into backups/ while Eigen runs, prints each step, and ends with
archive=<name>. Exits 0 once the archive verified, 1 when it failed, 2 on a wrong argument, and 4
when it verified but did not reach the backup bucket.

  --level    full (the default): everything but the files in S3 buckets, which keep their own
             history; full-s3: those too; light: accounts, settings and databases, no files or mail
  --reason   manual (the default), or pre-update, which ./eigen update passes
  --wait     Wait for a server backup that runs to end, instead of failing`;

type BackupFlags = ReturnType<typeof parseArgs<{ options: typeof BACKUP_OPTIONS }>>['values'];

function refuse(message: string): never {
    console.error(`${message}\n\n${BACKUP_USAGE}`);
    process.exit(2);
}

// Why a start was refused: the 409 names the backup that runs, the 507 the room it needs.
function nextAfter(status: number): string {
    if (status === 409) return 'Wait for it to end, then run ./eigen backup again.';
    if (status === 507)
        return 'Make room for backups/, or delete archives you no longer need, then run ./eigen backup again.';
    return 'Run ./eigen logs eigen-api to see what went wrong.';
}

// Starts the job on the running API and follows it to its end. Only the API's job map keeps a backup off a home a
// restore writes, so with Eigen down nothing runs it.
export async function backup(flags: BackupFlags): Promise<void> {
    const level = BACKUP_LEVELS.find((candidate) => candidate === flags.level);
    const reason = ON_DEMAND_BACKUP_REASONS.find((candidate) => candidate === flags.reason);
    if (!level) return refuse(`Unknown level "${flags.level}".`);
    if (!reason) return refuse(`Unknown reason "${flags.reason}".`);
    const ui = await createUi(true);
    const down = (): never =>
        ui.fail(
            'Eigen is not running, and a backup runs on the running server.',
            'Start it with ./eigen restart. With Eigen stopped, a copy of data/ and .env.production is a backup too.',
        );
    const lost = (): never =>
        ui.fail('Eigen stopped answering during the backup.', 'Run ./eigen logs eigen-api to see why.');

    // No idle timeout: a pre-update backup waits out a running one in silence, and Bun's client would cut it at five minutes.
    const start = (wait: boolean) =>
        callControl('/backup', down, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ level, reason, wait }),
            timeout: false,
        });
    let res = await start(false);
    // Asked first without waiting, so the wait is announced only when there is one.
    if (res.status === 409 && flags.wait) {
        console.log(glyphLine('active', 'Waiting for the running server backup to end'));
        res = await start(true);
    }
    if (!res.ok) ui.fail(await res.text(), nextAfter(res.status));
    const job: ControlBackupJob = await res.json();
    ui.intro(`Backing up the server into ${job.artifact}`);

    const fetchJob = async (id: string): Promise<ControlBackupJob> => {
        const next = await callControl(`/backup/jobs/${id}`, lost);
        if (!next.ok) lost();
        return next.json();
    };
    // Prints each step it sees until the job ends.
    let step = '';
    const follow = async (running: ControlBackupJob): Promise<ControlBackupJob> => {
        let current = running;
        while (current.state === 'running') {
            if (current.progress.step !== step && current.progress.step !== 'starting')
                console.log(glyphLine('bar', current.progress.step));
            step = current.progress.step;
            await Bun.sleep(POLL_MS);
            current = await fetchJob(current.id);
        }
        return current;
    };

    const saved = await follow(job);
    if (saved.state === 'failed')
        ui.fail(saved.error ?? 'The backup failed.', 'Run ./eigen logs eigen-api to see what went wrong.');
    // The archive goes up in a job of its own once the backup is done.
    const uploaded = saved.uploadJobId ? await follow(await fetchJob(saved.uploadJobId)) : null;
    if (uploaded?.state === 'failed') {
        console.error(glyphLine('warn', `Not uploaded: ${uploaded.error}`));
        console.error(glyphLine('bar', 'Upload it again from the Backups section in Settings.'));
    }
    ui.outro(`Saved ${saved.artifact}: ${BACKUP_LEVEL_NAMES[level]}, ${formatFileSize(saved.bytes ?? 0)}.`);
    console.log(`archive=${saved.artifact}`);
    if (uploaded?.state === 'failed') process.exit(NOT_UPLOADED);
}
