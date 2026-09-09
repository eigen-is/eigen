import * as fs from 'node:fs';
import { BACKUP_UPLOAD_MAX_BYTES } from '@workspace/lib/constants/backup';
import type { BackupArtifact, BackupJob, BackupSafetyCopy } from '@workspace/lib/types/backup';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { Elysia, t } from 'elysia';
import { readArtifactManifest, writeSidecar } from '../lib/backup/archive';
import {
    deleteArtifact,
    listArtifacts,
    listSafetyCopies,
    resolveArtifact,
    resolveSafetyCopyPath,
} from '../lib/backup/artifacts';
import { getBackupJob, listBackupJobs, runArtifactVerify, runHomeBackup, startBackupJob } from '../lib/backup/jobs';
import { getBackupTempPath, parseArtifactName } from '../lib/backup/paths';
import { restoreHome } from '../lib/backup/restore';
import { ApiError } from '../lib/core';
import { requireAdmin } from '../lib/core/access';
import { contentDisposition } from '../lib/core/http';
import { writeTempWithHash } from '../lib/drive/streaming';
import { getHome } from '../lib/home';
import { getTeam } from '../lib/team/team';
import { getUserById } from '../lib/user';
import { betterAuth } from './auth';

// Owner ids reach the filesystem through the home folder they name, so the shape is checked before
// anything is resolved: this class holds a uuid and a `team_{id}`, and holds no `/`, `..` or dot.
const OWNER_ID = /^[A-Za-z0-9_-]+$/;

// Guest homes are disposable (guest-cleanup deletes them) and org homes hold no databases, so
// neither is backed up. A user who no longer exists is a valid restore target — that is the
// restore-after-deletion case — and never a valid backup target.
async function requireHomeOwner(ownerId: string, mustExist: boolean): Promise<void> {
    if (!OWNER_ID.test(ownerId)) throw new ApiError(400, 'Invalid ownerId');
    const owner = parseOwnerId(ownerId);
    if (owner.type === 'team') {
        if (mustExist && !(await getTeam(owner.id))) throw new ApiError(404, 'Team not found');
        return;
    }
    if (owner.type !== 'user') throw new ApiError(400, `Cannot back up a ${owner.type} home`);
    const target = await getUserById(owner.id);
    if (!target) {
        if (mustExist) throw new ApiError(404, 'User not found');
        return;
    }
    if (target.role === 'guest') throw new ApiError(400, 'Guest homes are not backed up');
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
            await requireHomeOwner(params.ownerId, true);
            // Resolved here and handed to the job: lib/backup never reaches for a home of its own.
            const home = await getHome(params.ownerId);
            const job = startBackupJob('backup', params.ownerId, user.id, (jobId, onProgress) =>
                runHomeBackup(home, user.id, jobId, onProgress),
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
            await requireHomeOwner(query.ownerId, false);
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
                throw new ApiError(413, 'A backup upload must declare a Content-Length of at most 1 GB');
            }
            const { artifactPath } = resolveArtifact(name);
            if (fs.existsSync(artifactPath)) throw new ApiError(409, 'That artifact is already in the backups folder');
            if (!request.body) throw new ApiError(400, 'Upload has no body');

            // Staged next to the backups folder so the rename below is atomic: an interrupted upload
            // never leaves a short archive under a name the list would offer for restore.
            // writeTempWithHash is the repo's stream-into-a-temp seam; its sha256 is incidental here.
            const tempPath = getBackupTempPath('.tar.zst');
            try {
                const { size } = await writeTempWithHash(tempPath, request.body);
                // Content-Length is the client's word for it; the bytes are what count.
                if (size > BACKUP_UPLOAD_MAX_BYTES) throw new ApiError(413, 'Upload too large');
            } catch (error) {
                fs.rmSync(tempPath, { force: true });
                throw error;
            }
            fs.renameSync(tempPath, artifactPath);

            try {
                const manifest = await readArtifactManifest(artifactPath);
                if (manifest.ownerId !== ownerId) {
                    throw new ApiError(400, `That archive is a backup of ${manifest.ownerId}, not of ${ownerId}`);
                }
                await writeSidecar(artifactPath, manifest, { status: 'unverified', failures: [] });
            } catch (error) {
                // An archive nothing can read is not an artifact; keeping it would put a row in the
                // list that every later action fails on.
                deleteArtifact(artifactPath);
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
        async ({ params, user }) => {
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
            deleteArtifact(resolveArtifact(params.name).artifactPath);
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
            const job = startBackupJob('verify', ownerId, user.id, (jobId, onProgress) =>
                runArtifactVerify(params.name, jobId, onProgress),
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
            await requireHomeOwner(body.ownerId, false);
            const job = startBackupJob('restore', body.ownerId, user.id, async (jobId, onProgress) => {
                await restoreHome(params.name, body.ownerId, jobId, onProgress);
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
            await requireHomeOwner(params.ownerId, false);
            const folder = await resolveSafetyCopyPath(params.ownerId, params.name);
            if (!fs.existsSync(folder)) throw new ApiError(404, 'Safety copy not found');
            fs.rmSync(folder, { recursive: true, force: true });
            return { success: true };
        },
        { auth: true },
    );
