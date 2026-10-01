import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerArchive, ServerArchiveSidecar, ServerArchiveUpload } from '@workspace/lib/types/backup';
import { parseServerArchiveName, parseServerArchiveNames, parseServerArchiveSidecar } from '@workspace/lib/validation';
import { API_IMAGE_KEY } from '../config/release';
import { getServerSettings } from '../config/server-settings';
import { ApiError } from '../core';
import { sendToHome } from '../home/home-relay';
import { getOrgOwner } from '../user';
import { writeRecord } from './archive';
import { runningJobOn } from './jobs';
import { backupsDirPath, SERVER_SIDECAR_SUFFIX, serverSidecarPath } from './paths';
import { pruneServerArchives } from './retention';

// The server archives and their records in the backups folder: what the owner's list reads, what a delete takes
// with it, retention, and the boot that ends a record left running. Running a backup or an upload is server-job.ts.

const INTERRUPTED = 'interrupted by a restart';

export function writeServerSidecar(archivePath: string, sidecar: ServerArchiveSidecar): Promise<void> {
    return writeRecord(serverSidecarPath(archivePath), sidecar);
}

// Null when there is none, or none that reads: nothing is judged or deleted on a record nobody can read.
export async function readServerSidecar(archivePath: string): Promise<ServerArchiveSidecar | null> {
    const text = await Bun.file(serverSidecarPath(archivePath))
        .text()
        .catch(() => null);
    return text === null ? null : parseServerArchiveSidecar(text);
}

// Fire-and-forget like the poke: a relay that fails must not replace the failure the job records.
export function alertOwner(tag: string, error: string, title = 'Server backup failed'): void {
    getOrgOwner()
        .then((owner) =>
            owner
                ? sendToHome(owner.id, {
                      type: 'notification',
                      notification: {
                          type: 'admin-alert',
                          title,
                          body: error,
                          tag: `server-backup-${tag}`,
                          coalesce: true,
                      },
                  })
                : undefined,
        )
        .catch(() => {});
}

// Every server archive and refused attempt in the backups folder, once each, newest first.
function listServerRecords() {
    const dir = backupsDirPath();
    if (!fs.existsSync(dir)) return [];
    const names = new Set(
        fs
            .readdirSync(dir)
            .map((file) =>
                file.endsWith(SERVER_SIDECAR_SUFFIX) ? file.slice(0, -SERVER_SIDECAR_SUFFIX.length) : file,
            ),
    );
    return parseServerArchiveNames(names).map((record) => ({ ...record, archivePath: path.join(dir, record.name) }));
}

// The owner's list, newest first, from names and sidecars alone.
export async function listServerArchives(): Promise<ServerArchive[]> {
    const archives: ServerArchive[] = [];
    for (const { name, level, reason, at, archivePath } of listServerRecords()) {
        archives.push({
            name,
            level,
            reason,
            createdAt: at,
            bytes: fs.statSync(archivePath, { throwIfNoEntry: false })?.size ?? null,
            record: await readServerSidecar(archivePath),
        });
    }
    return archives;
}

// The schedule's one question. A failed or refused attempt left its record, so it counts: a night
// that fails is one alert, not a retry every tick.
export function hasScheduledAttemptOn(day: Date): boolean {
    const date = day.toISOString().slice(0, 10);
    return listServerRecords().some(
        ({ reason, at }) => reason === 'scheduled' && at.toISOString().slice(0, 10) === date,
    );
}

// An archive and its record go together. Only a running job refuses, as it would write the record back: a record
// left running with no job behind it lost its final write.
export async function deleteServerArchive(name: string): Promise<void> {
    if (!parseServerArchiveName(name)) throw new ApiError(400, 'Not a server backup name');
    const archivePath = path.join(backupsDirPath(), name);
    const recordPath = serverSidecarPath(archivePath);
    if (!fs.existsSync(archivePath) && !fs.existsSync(recordPath)) throw new ApiError(404, 'Archive not found');
    if (runningJobOn(name)) throw new ApiError(409, `${name} is still being written`);
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(recordPath, { force: true });
}

// Retention by each sidecar: an archive is good only when its job ended done, and nothing is deleted on a record
// nobody can read.
export async function pruneLocalArchives(): Promise<void> {
    const archives: Parameters<typeof pruneServerArchives>[0] = [];
    const unread: string[] = [];
    for (const record of listServerRecords()) {
        const sidecar = await readServerSidecar(record.archivePath);
        if (sidecar) {
            archives.push({
                ...record,
                good: sidecar.state === 'done',
                build: sidecar.manifest?.images[API_IMAGE_KEY],
            });
        } else unread.push(record.name);
    }
    if (unread.length > 0) {
        console.warn(`[backup] retention skips archives without a readable record: ${unread.join(', ')}`);
    }
    // An archive a job still reads, as an upload does, stays until the next round.
    const { keep } = getServerSettings().backups.schedule;
    for (const name of pruneServerArchives(archives, keep, process.env[API_IMAGE_KEY])) {
        if (runningJobOn(name)) continue;
        const archivePath = path.join(backupsDirPath(), name);
        fs.rmSync(archivePath, { force: true });
        fs.rmSync(serverSidecarPath(archivePath), { force: true });
    }
}

// Boot: a job or an upload killed mid-run left its record running, and nothing will ever end it, so it becomes a
// failed one. The owner hears of each once.
export async function recoverInterruptedServerBackups(): Promise<void> {
    const interrupted: string[] = [];
    const notUploaded: string[] = [];
    for (const { name, archivePath } of listServerRecords()) {
        const sidecar = await readServerSidecar(archivePath);
        if (sidecar?.state === 'running') {
            await writeServerSidecar(archivePath, {
                ...sidecar,
                state: 'failed',
                error: INTERRUPTED,
                finishedAt: new Date(),
            });
            interrupted.push(name);
        } else if (sidecar?.upload?.state === 'running') {
            const upload: ServerArchiveUpload = {
                ...sidecar.upload,
                state: 'failed',
                at: new Date(),
                error: INTERRUPTED,
            };
            await writeServerSidecar(archivePath, { ...sidecar, upload });
            notUploaded.push(name);
        }
    }
    if (interrupted.length > 0) alertOwner('interrupted', `${interrupted.join(', ')}: ${INTERRUPTED}`);
    if (notUploaded.length > 0) {
        alertOwner('upload-interrupted', `${notUploaded.join(', ')}: ${INTERRUPTED}`, 'Server backup not uploaded');
    }
}
