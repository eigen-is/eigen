import * as fs from 'node:fs';
import * as path from 'node:path';
import { BACKUP_UPLOAD_MAX_BYTES, BACKUP_UPLOAD_MAX_LABEL } from '@workspace/lib/constants/backup';
import type { BackupArtifact, BackupJob, BackupSafetyCopy } from '@workspace/lib/types/backup';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { BACKUP_ARTIFACT_EXTENSION, BACKUP_OWNER_ID, parseBackupArtifactName } from '@workspace/lib/validation';
import { Elysia, t } from 'elysia';
import { readArtifactManifest, writeSidecar } from '../lib/backup/archive';
import {
    deleteArtifact,
    deleteSafetyCopy,
    landUploadedArtifact,
    listArtifacts,
    listSafetyCopies,
    resolveArtifact,
    resolveSafetyCopy,
} from '../lib/backup/artifacts';
import {
    getBackupJob,
    listBackupJobs,
    runArtifactVerify,
    runHomeBackup,
    startBackupJob,
    withBackupJobSlot,
} from '../lib/backup/jobs';
import { getBackupsDir, getBackupTempPath } from '../lib/backup/paths';
import { restoreHome, restoreSafetyCopy } from '../lib/backup/restore';
import type { SnapshotProgress } from '../lib/backup/snapshot-home';
import { ApiError } from '../lib/core';
import { requireAdmin } from '../lib/core/access';
import { contentDisposition } from '../lib/core/http';
import { writeTempWithHash } from '../lib/drive/streaming';
import { getHome } from '../lib/home';
import { getTeam } from '../lib/team/team';
import { getUserById } from '../lib/user';
import { betterAuth } from './auth';

// Guest homes are disposable (guest-cleanup deletes them) and org homes hold no databases, so
// neither is backed up. The ownerId ends up naming a home folder, so its shape is checked here,
// against the one class the shared artifact-name grammar allows, before anything is resolved.
async function requireRestorableHome(ownerId: string): Promise<void> {
    if (!BACKUP_OWNER_ID.test(ownerId)) throw new ApiError(400, 'Invalid ownerId');
    const owner = parseOwnerId(ownerId);
    if (owner.type !== 'user' && owner.type !== 'team') throw new ApiError(400, 'Not a user or team home');
    if (owner.type === 'user' && (await getUserById(owner.id))?.role === 'guest') {
        throw new ApiError(400, 'Guest homes are not backed up');
    }
}

// A backup also needs the home to be there. A restore does not: restoring a user who was deleted is
// what the auth rows inside the archive are for.
async function requireExistingHome(ownerId: string): Promise<void> {
    await requireRestorableHome(ownerId);
    const owner = parseOwnerId(ownerId);
    if (owner.type === 'team') {
        if (!(await getTeam(owner.id))) throw new ApiError(404, 'Team not found');
        return;
    }
    if (!(await getUserById(owner.id))) throw new ApiError(404, 'User not found');
}

// A restore ends with the home evicted. On a remote mount it also ends with every file in the
// mount's staging folder and one `pending_uploads` row per file, and the queue that drains them is a
// Mount member — nothing runs it until the home is next opened, so an admin who restores a home
// nobody then visits leaves the bucket stale. Opening the home here is what starts it: Mount.init
// stands up the UploadQueue and reconciles the persisted rows. Routes may call getHome; the job
// bodies in lib/backup may not, which is why this lives here and not in jobs.ts.
function startRestoreJob(
    ownerId: string,
    adminId: string,
    artifact: string,
    restore: (jobId: string, onProgress: SnapshotProgress) => Promise<void>,
): { jobId: string } {
    const job = startBackupJob('restore', ownerId, adminId, async (started, onProgress) => {
        await restore(started.id, onProgress);
        // The restore itself is done. A home that fails to open now is the next request's problem,
        // not a failed restore.
        await getHome(ownerId).catch((error: unknown) => {
            console.error(`[backup] could not warm the restored home ${ownerId}:`, error);
        });
        return artifact;
    });
    return { jobId: job.id };
}

// Server-wide admin surface, the settings.ts carve-out: no `:ownerId` second segment, every handler
// behind requireAdmin. The routes start jobs and read the backups folder; the jobs themselves are
// in-memory (lib/backup/jobs.ts) and the folder is the durable record.
export const backupRouter = new Elysia({ name: 'backup' })
    .use(betterAuth)

    .post(
        '/admin/backup/home/:ownerId',
        async ({ params, user }): Promise<{ jobId: string }> => {
            await requireAdmin(user.id);
            await requireExistingHome(params.ownerId);
            // Another user's home, resolved here and handed to the job: lib/backup never reaches for
            // a home of its own. Phase ③ runs the job on the server that owns the home, and this
            // lookup moves behind home-relay with it (ROADMAP, cheap wins).
            const home = await getHome(params.ownerId);
            const job = startBackupJob('backup', params.ownerId, user.id, (started, onProgress) =>
                runHomeBackup(home, started, onProgress),
            );
            return { jobId: job.id };
        },
        { auth: true },
    )

    .get(
        '/admin/backup/jobs',
        async ({ query, user }): Promise<BackupJob[]> => {
            await requireAdmin(user.id);
            return listBackupJobs(query.ownerId);
        },
        { auth: true, query: t.Object({ ownerId: t.Optional(t.String()) }) },
    )

    .get(
        '/admin/backup/jobs/:id',
        async ({ params, user }): Promise<BackupJob> => {
            await requireAdmin(user.id);
            const job = getBackupJob(params.id);
            if (!job) throw new ApiError(404, 'Job not found');
            return job;
        },
        { auth: true },
    )

    .get(
        '/admin/backup/artifacts',
        async ({ query, user }): Promise<{ artifacts: BackupArtifact[]; safetyCopies: BackupSafetyCopy[] }> => {
            await requireAdmin(user.id);
            await requireRestorableHome(query.ownerId);
            return {
                artifacts: await listArtifacts(query.ownerId),
                safetyCopies: await listSafetyCopies(query.ownerId),
            };
        },
        { auth: true, query: t.Object({ ownerId: t.String() }) },
    )

    .post(
        '/admin/backup/artifacts',
        async ({ query, request, user }): Promise<{ name: string }> => {
            await requireAdmin(user.id);
            // The name is a query parameter, not a header: a custom request header makes the upload
            // a CORS-preflighted request, and a split-origin deployment (every dev setup) answers
            // that preflight without it. It has to be a name this server writes — the ownerId in it
            // is what the artifact list groups by, and it is the name the bytes land under.
            const parsed = parseBackupArtifactName(query.name);
            if (!parsed) throw new ApiError(400, 'The name parameter must be a backup artifact name');
            const { name } = query;
            const { ownerId } = parsed;
            const declared = Number(request.headers.get('content-length'));
            if (!Number.isSafeInteger(declared) || declared <= 0 || declared > BACKUP_UPLOAD_MAX_BYTES) {
                throw new ApiError(
                    413,
                    `A backup upload must declare a Content-Length of at most ${BACKUP_UPLOAD_MAX_LABEL}`,
                );
            }
            const artifactPath = path.join(getBackupsDir(), name);
            if (fs.existsSync(artifactPath)) throw new ApiError(409, 'That artifact is already in the backups folder');
            if (!request.body) throw new ApiError(400, 'Upload has no body');

            // Staged next to the backups folder so the landing below is one filesystem operation: an
            // interrupted upload never leaves a short archive under a name the list would offer for
            // restore. writeTempWithHash is the stream-into-a-temp seam; its sha256 is incidental.
            const tempPath = getBackupTempPath(BACKUP_ARTIFACT_EXTENSION);
            try {
                const { size } = await writeTempWithHash(tempPath, request.body);
                // Content-Length is the client's word for it; the bytes are what count.
                if (size !== declared) throw new ApiError(400, 'Upload does not match its Content-Length');
                landUploadedArtifact(tempPath, artifactPath);
            } finally {
                fs.rmSync(tempPath, { force: true });
            }

            try {
                const manifest = await readArtifactManifest(artifactPath);
                if (manifest.ownerId !== ownerId) {
                    throw new ApiError(400, `That archive is a backup of ${manifest.ownerId}, not of ${ownerId}`);
                }
                await writeSidecar(artifactPath, manifest, { status: 'unverified', failures: [] });
            } catch (error) {
                // An archive nothing can read is not an artifact; keeping it would put a row in the
                // list that every later action fails on. Only the file this request landed goes —
                // the sidecar, if there is one, belongs to whatever wrote it.
                fs.rmSync(artifactPath, { force: true });
                if (error instanceof ApiError) throw error;
                // Anything that is not a readable .tar.zst fails deep inside the decompressor.
                throw new ApiError(400, 'That upload is not a readable Eigen backup archive');
            }
            return { name };
        },
        { auth: true, parse: 'none', query: t.Object({ name: t.String() }) },
    )

    .get(
        '/admin/backup/artifacts/:name',
        async ({ params, user }): Promise<Response> => {
            await requireAdmin(user.id);
            const { artifactPath } = resolveArtifact(params.name);
            const file = Bun.file(artifactPath);
            if (!(await file.exists())) throw new ApiError(404, 'Artifact not found');
            return new Response(file.stream(), {
                headers: {
                    'Content-Type': 'application/zstd',
                    'Content-Disposition': contentDisposition('attachment', params.name),
                    'Content-Length': String(file.size),
                    'Cache-Control': 'private, no-store',
                },
            });
        },
        { auth: true },
    )

    .delete(
        '/admin/backup/artifacts/:name',
        async ({ params, user }): Promise<{ success: boolean }> => {
            await requireAdmin(user.id);
            const { artifactPath } = resolveArtifact(params.name);
            if (!fs.existsSync(artifactPath)) throw new ApiError(404, 'Artifact not found');
            deleteArtifact(artifactPath);
            return { success: true };
        },
        { auth: true },
    )

    .post(
        '/admin/backup/artifacts/:name/verify',
        async ({ params, user }): Promise<{ jobId: string }> => {
            await requireAdmin(user.id);
            const { artifactPath, ownerId } = resolveArtifact(params.name);
            if (!fs.existsSync(artifactPath)) throw new ApiError(404, 'Artifact not found');
            const job = startBackupJob('verify', ownerId, user.id, (started, onProgress) =>
                runArtifactVerify(params.name, started, onProgress),
            );
            return { jobId: job.id };
        },
        { auth: true },
    )

    .post(
        '/admin/backup/artifacts/:name/restore',
        async ({ params, body, user }): Promise<{ jobId: string }> => {
            await requireAdmin(user.id);
            const { artifactPath, ownerId } = resolveArtifact(params.name);
            // The name's ownerId is a cheap pre-flight for the typed confirmation in the body; the
            // restore itself judges the manifest inside the archive, which is the canonical answer.
            if (ownerId !== body.ownerId) throw new ApiError(400, 'That artifact is a backup of another home');
            if (!fs.existsSync(artifactPath)) throw new ApiError(404, 'Artifact not found');
            await requireRestorableHome(body.ownerId);
            return startRestoreJob(body.ownerId, user.id, params.name, (jobId, onProgress) =>
                restoreHome(params.name, body.ownerId, jobId, onProgress),
            );
        },
        { auth: true, body: t.Object({ ownerId: t.String() }) },
    )

    .delete(
        '/admin/backup/safety/:ownerId/:name',
        async ({ params, user }): Promise<{ success: boolean }> => {
            await requireAdmin(user.id);
            await requireRestorableHome(params.ownerId);
            const { folder, homeDir } = await resolveSafetyCopy(params.ownerId, params.name);
            if (!fs.existsSync(folder)) throw new ApiError(404, 'Safety copy not found');
            // Synchronous, but it holds the home's one job slot for its whole duration: it decides
            // what is garbage by reading the live home's storage keys, and a restore swapping that
            // folder underneath it would turn the answer into "delete what the home now points at".
            await withBackupJobSlot(params.ownerId, () => deleteSafetyCopy(folder, homeDir));
            return { success: true };
        },
        { auth: true },
    )

    .post(
        '/admin/backup/safety/:ownerId/:name/restore',
        async ({ params, user }): Promise<{ jobId: string }> => {
            await requireAdmin(user.id);
            // A copy of a home whose owner is gone cannot be restored, only deleted: putting the
            // folder back would leave a home nobody can sign in to.
            await requireExistingHome(params.ownerId);
            // The kind is judged before the folder is looked for: a `.failed-restore-` copy is not a
            // home this can put back, whether or not one by that name is there.
            const { folder, kind } = await resolveSafetyCopy(params.ownerId, params.name);
            if (kind !== 'pre-restore') throw new ApiError(400, 'Only a pre-restore copy can be restored');
            if (!fs.existsSync(folder)) throw new ApiError(404, 'Safety copy not found');
            return startRestoreJob(params.ownerId, user.id, params.name, (jobId, onProgress) =>
                restoreSafetyCopy(params.ownerId, params.name, jobId, onProgress),
            );
        },
        { auth: true },
    );
