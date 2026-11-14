// The Drive HTTP routes that list across an owner's drive rather than inside one folder, such as its
// mounts, what is shared by or with the user, the files of one MIME type, watched paths and recent files.
// Most go through getSharedDrive, which checks the access. A listing that reads only the caller's own data,
// or gathers it from other homes such as the user's team drives, calls requireSelf first.

import type { DrivePath, RecentPath } from '@workspace/lib/types/drive';
import type { MountInfo } from '@workspace/lib/types/mount';
import { Elysia, t } from 'elysia';
import { requireNonGuest, requireSelf } from '../lib/auth/access';
import { getDrive, getSharedDrive } from '../lib/drive';
import { aggregateMimeContents, aggregateRecents, aggregateWatches } from '../lib/drive/aggregate';
import { betterAuth } from './auth';

export const driveListingsRouter = new Elysia({ name: 'drive-listings' })
    .use(betterAuth)
    .get(
        '/drive/:ownerId/mounts',
        async ({ params, user }): Promise<MountInfo[]> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.listMounts();
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/shared/by-me',
        async ({ params, user }): Promise<DrivePath[]> => {
            // SharedDrive has no shared-by-me listing, so a call for another owner's drive is refused here.
            requireSelf(params.ownerId, user.id);
            const drive = await getDrive(user);
            return await drive.getSharedPathsByMe();
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/shared/with-me',
        async ({ params, user }): Promise<DrivePath[]> => {
            requireSelf(params.ownerId, user.id);
            const drive = await getDrive(user);
            return await drive.getSharedPathsWithMe();
        },
        { auth: true },
    )
    // The files of one MIME type in every mount of the drive. With ?teams=1 the caller's team drives
    // are searched too.
    .get(
        '/drive/:ownerId/mime/:mimeType',
        async ({ params, query, user }): Promise<DrivePath[]> => {
            const mimeType = params.mimeType.replace('-', '/');

            if (!query.teams) {
                const drive = await getSharedDrive(params.ownerId, user);
                return await drive.getMimeTypeContents(mimeType);
            }

            // Aggregation reads other homes (team mounts), so it is self-only.
            requireSelf(params.ownerId, user.id);
            return await aggregateMimeContents(user, mimeType);
        },
        { auth: true, query: t.Object({ teams: t.Optional(t.String()) }) },
    )
    .get(
        '/drive/:ownerId/:mountId/mime/:mimeType',
        async ({ params, user }): Promise<DrivePath[]> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getMountMimeTypeContents(params.mountId, params.mimeType.replace('-', '/'));
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/watches',
        async ({ params, query, user }): Promise<DrivePath[]> => {
            if (!query.all) {
                const drive = await getSharedDrive(params.ownerId, user);
                return drive.getWatches(user);
            }

            // Aggregation reads other homes (team mounts, foreign-owner shares), so it is self-only.
            requireSelf(params.ownerId, user.id);
            return aggregateWatches(user);
        },
        { auth: true, query: t.Object({ all: t.Optional(t.String()) }) },
    )
    .get(
        '/drive/:ownerId/recent',
        async ({ params, user }): Promise<RecentPath[]> => {
            requireSelf(params.ownerId, user.id);
            requireNonGuest(user);
            return aggregateRecents(user);
        },
        { auth: true },
    );
