import type { ServerArchiveList } from '@workspace/lib/types/backup';
import { BACKUP_LEVELS } from '@workspace/lib/validation';
import { Elysia, t } from 'elysia';
import { hasS3Mounts } from '../lib/backup/enumerate-homes';
import { deleteServerArchive, listServerArchives, startServerBackup } from '../lib/backup/server-job';
import { getServerSettings } from '../lib/config/server-settings';
import { requireOwner } from '../lib/core/access';
import { betterAuth } from './auth';

// The whole-server backup, the owner's alone: an archive holds every mailbox, every password hash
// and every mount's keys. Server-wide, so no `:ownerId`. No download: an archive leaves the box by
// scp or the bucket, never through a browser.
export const serverBackupRouter = new Elysia({ name: 'server-backup' })
    .use(betterAuth)

    .post(
        '/admin/server-backup',
        async ({ body, user }): Promise<{ jobId: string }> => {
            await requireOwner(user.id);
            const { keep } = getServerSettings().backups.schedule;
            const job = await startServerBackup({ level: body.level, reason: 'manual', keep, startedBy: user.id });
            return { jobId: job.id };
        },
        { auth: true, body: t.Object({ level: t.UnionEnum(BACKUP_LEVELS) }) },
    )

    .get(
        '/admin/server-backup/archives',
        async ({ user }): Promise<ServerArchiveList> => {
            await requireOwner(user.id);
            return { archives: await listServerArchives(), hasS3Mounts: hasS3Mounts() };
        },
        { auth: true },
    )

    .delete(
        '/admin/server-backup/archives/:name',
        async ({ params, user }): Promise<{ success: boolean }> => {
            await requireOwner(user.id);
            await deleteServerArchive(params.name);
            return { success: true };
        },
        { auth: true },
    );
