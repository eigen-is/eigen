import { MOUNT_STORAGE_TYPES, withoutSecret } from '@workspace/lib/types/mount';
import { parseOwnerId } from '@workspace/lib/types/owner';
import type { MountSettings, TeamSettings } from '@workspace/lib/types/settings';
import { Elysia, t } from 'elysia';
import { enforceMaxUploadSize } from '../lib/config/enforcement';
import { requireTeamAccess, requireTeamAdmin } from '../lib/core/access';
import { ApiError } from '../lib/core/errors';
import { getTeamHome } from '../lib/home';
import { pushTeamAvatar } from '../lib/home/home-relay';
import { generateImagePreview } from '../lib/shared/thumbnails';
import { getTeamExists, getTeamMembers } from '../lib/team';
import { betterAuth } from './auth';
import { s3ConfigBody, s3ConfigUpdateBody, toS3Config } from './shared-schemas';

function teamId(ownerId: string): string {
    const parsed = parseOwnerId(ownerId);
    if (parsed.type !== 'team') throw new ApiError(400, 'Invalid teamId format');
    return parsed.id;
}

function withoutMountSecret(mount: MountSettings): MountSettings {
    return mount.s3Config ? { ...mount, s3Config: withoutSecret(mount.s3Config) } : mount;
}

export const teamRouter = new Elysia({ name: 'team' })
    .use(betterAuth)

    .get(
        '/team/:ownerId/members',
        async ({ params, user }): Promise<{ userId: string; email: string; name: string }[]> => {
            await requireTeamAccess(user.id, teamId(params.ownerId));
            const members = await getTeamMembers(teamId(params.ownerId));
            return members.map((m) => ({ userId: m.user.id, email: m.user.email, name: m.user.name }));
        },
        { auth: true },
    )

    .get(
        '/team/:ownerId/settings',
        async ({ params, user }): Promise<TeamSettings> => {
            await requireTeamAccess(user.id, teamId(params.ownerId));
            const home = await getTeamHome(params.ownerId);
            return home.settings.get();
        },
        { auth: true },
    )

    .put(
        '/team/:ownerId/settings',
        async ({ params, body, user }): Promise<TeamSettings> => {
            await requireTeamAdmin(user.id, teamId(params.ownerId));
            const home = await getTeamHome(params.ownerId);
            return await home.settings.set({
                ...body,
                memberOverrides: body.memberOverrides
                    ? {
                          mailAndContactsMaxMB: body.memberOverrides.mailAndContactsMaxMB ?? undefined,
                          defaultMountMaxSizeMB: body.memberOverrides.defaultMountMaxSizeMB ?? undefined,
                      }
                    : undefined,
            });
        },
        {
            body: t.Object({
                calendar: t.Optional(t.Object({ enabled: t.Optional(t.Boolean()) })),
                memberOverrides: t.Optional(
                    t.Object({
                        mailAndContactsMaxMB: t.Optional(t.Nullable(t.Number({ minimum: 10 }))),
                        defaultMountMaxSizeMB: t.Optional(t.Nullable(t.Number({ minimum: 10 }))),
                    }),
                ),
            }),
            auth: true,
        },
    )

    .get(
        '/team/:ownerId/mounts',
        async ({ params, user }): Promise<Record<string, MountSettings>> => {
            await requireTeamAdmin(user.id, teamId(params.ownerId));
            const home = await getTeamHome(params.ownerId);
            const mounts = Object.entries(home.settings.get().mounts ?? {});
            return Object.fromEntries(mounts.map(([id, mount]) => [id, withoutMountSecret(mount)]));
        },
        { auth: true },
    )

    .post(
        '/team/:ownerId/mount',
        async ({ params, body, user }): Promise<{ id: string } & MountSettings> => {
            await requireTeamAdmin(user.id, teamId(params.ownerId));
            const home = await getTeamHome(params.ownerId);
            const { id, ...mount } = await home.addMount({
                ...body,
                s3Config: body.s3Config && toS3Config(body.s3Config),
            });
            return { id, ...withoutMountSecret(mount) };
        },
        {
            body: t.Object({
                name: t.String({ minLength: 1 }),
                storageType: t.Optional(t.UnionEnum(MOUNT_STORAGE_TYPES)),
                maxSizeMB: t.Optional(t.Number({ minimum: 10 })),
                s3Config: t.Optional(s3ConfigBody),
            }),
            auth: true,
        },
    )

    .put(
        '/team/:ownerId/mount/:mountId',
        async ({ params, body, user }): Promise<MountSettings> => {
            await requireTeamAdmin(user.id, teamId(params.ownerId));
            const home = await getTeamHome(params.ownerId);
            // A key set to undefined would replace the saved config.
            const { s3Config, ...update } = body;
            const updated = await home.updateMount(
                params.mountId,
                s3Config ? { ...update, s3Config: toS3Config(s3Config) } : update,
            );
            return withoutMountSecret(updated);
        },
        {
            body: t.Object({
                enabled: t.Optional(t.Boolean()),
                maxSizeMB: t.Optional(t.Number({ minimum: 10 })),
                name: t.Optional(t.String({ minLength: 1 })),
                s3Config: t.Optional(s3ConfigUpdateBody),
            }),
            auth: true,
        },
    )

    .post(
        '/team/:ownerId/avatar',
        async ({ params, body, user }): Promise<void> => {
            const id = teamId(params.ownerId);
            await requireTeamAdmin(user.id, id);
            if (!(await getTeamExists(id))) throw new ApiError(404, 'Team not found');
            // Global max upload size only — a team avatar shouldn't bill the uploading admin's
            // personal mail+contacts quota (that's what enforceAvatarUpload adds on top).
            enforceMaxUploadSize(body.file.size);
            const buffer = Buffer.from(await body.file.arrayBuffer());
            const result = await generateImagePreview(buffer, body.file.type, body.file.name, '', 'avatar', {
                maxSize: 512,
                quality: 80,
                fit: 'cover',
            });
            if (!result) throw new ApiError(400, 'Failed to generate avatar thumbnail');
            await pushTeamAvatar(id, result.data);
        },
        {
            body: t.Object({ file: t.File({ format: 'image/*' }) }),
            auth: true,
        },
    )

    .delete(
        '/team/:ownerId/avatar',
        async ({ params, user }): Promise<void> => {
            const id = teamId(params.ownerId);
            await requireTeamAdmin(user.id, id);
            if (!(await getTeamExists(id))) throw new ApiError(404, 'Team not found');
            await pushTeamAvatar(id, null);
        },
        { auth: true },
    );
