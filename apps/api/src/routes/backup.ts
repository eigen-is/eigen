import * as fs from 'node:fs';
import * as path from 'node:path';
import { BACKUP_UPLOAD_MAX_BYTES } from '@workspace/lib/constants/backup';
import type { BackupArtifact, BackupJob, BackupSafetyCopy } from '@workspace/lib/types/backup';
import { parseOwnerId } from '@workspace/lib/types/owner';
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
import { getBackupJob, listBackupJobs, runArtifactVerify, runHomeBackup, startBackupJob } from '../lib/backup/jobs';
import { getBackupsDir, getBackupTempPath, OWNER_ID, parseArtifactName } from '../lib/backup/paths';
import { restoreHome, restoreSafetyCopy } from '../lib/backup/restore';
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
// against the one class paths.ts allows, before anything is resolved.
async function requireRestorableHome(ownerId: string): Promise<void> {
    if (!OWNER_ID.test(ownerId)) throw new ApiError(400, 'Invalid ownerId');
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

// The uploaded artifact's name rides in Content-Disposition, the header a browser upload already
// carries for the file it is sending. It has to be a name this server writes: the ownerId in it is
// what the artifact list groups by, and it is the name the bytes land under.
function uploadName(header: string | null): { name: string; ownerId: string } {
    const name = /filename="([^"]*)"/.exec(header ?? '')?.[1] ?? '';
    const parsed = parseArtifactName(name);
    if (!parsed) throw new ApiError(400, 'Content-Disposition must name a backup artifact file');
    return { name, ownerId: parsed.ownerId };
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
        async ({ request, user }): Promise<{ name: string }> => {
            await requireAdmin(user.id);
            const { name, ownerId } = uploadName(request.headers.get('content-disposition'));
            const declared = Number(request.headers.get('content-length'));
            if (!Number.isSafeInteger(declared) || declared <= 0 || declared > BACKUP_UPLOAD_MAX_BYTES) {
                const limit = BACKUP_UPLOAD_MAX_BYTES / 1024 ** 3;
                throw new ApiError(413, `A backup upload must declare a Content-Length of at most ${limit} GB`);
            }
            const artifactPath = path.join(getBackupsDir(), name);
            if (fs.existsSync(artifactPath)) throw new ApiError(409, 'That artifact is already in the backups folder');
            if (!request.body) throw new ApiError(400, 'Upload has no body');

            // Staged next to the backups folder so the landing below is one filesystem operation: an
            // interrupted upload never leaves a short archive under a name the list would offer for
            // restore. writeTempWithHash is the stream-into-a-temp seam; its sha256 is incidental.
            const tempPath = getBackupTempPath('.tar.zst');
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
        { auth: true, parse: 'none' },
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
            const job = startBackupJob('restore', body.ownerId, user.id, async (started, onProgress) => {
                await restoreHome(params.name, body.ownerId, started.id, onProgress);
                return params.name;
            });
            return { jobId: job.id };
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
            await deleteSafetyCopy(folder, homeDir);
            return { success: true };
        },
        { auth: true },
    )

    .post(
        '/admin/backup/safety/:ownerId/:name/restore',
        async ({ params, user }): Promise<{ jobId: string }> => {
            await requireAdmin(user.id);
            await requireRestorableHome(params.ownerId);
            // The kind is judged before the folder is looked for: a `.failed-restore-` copy is not a
            // home this can put back, whether or not one by that name is there.
            const { folder, kind } = await resolveSafetyCopy(params.ownerId, params.name);
            if (kind !== 'pre-restore') throw new ApiError(400, 'Only a pre-restore copy can be restored');
            if (!fs.existsSync(folder)) throw new ApiError(404, 'Safety copy not found');
            const job = startBackupJob('restore', params.ownerId, user.id, async (started, onProgress) => {
                await restoreSafetyCopy(params.ownerId, params.name, started.id, onProgress);
                return params.name;
            });
            return { jobId: job.id };
        },
        { auth: true },
    );
