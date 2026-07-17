import { randomUUID } from 'node:crypto';
import { parseOwnerId } from '@workspace/lib/types';
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

function teamId(ownerId: string): string {
    const parsed = parseOwnerId(ownerId);
    return parsed.id;
}

export const teamRouter = new Elysia({ name: 'team' })
    .use(betterAuth)

    .get(
        '/team/:ownerId/members',
        async ({ params, user }) => {
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
            await requireTeamAccess(user.id, teamId(params.ownerId));
            const home = await getTeamHome(params.ownerId);
            return home.settings.get().mounts ?? {};
        },
        { auth: true },
    )

    .post(
        '/team/:ownerId/mount',
        async ({ params, body, user }) => {
            await requireTeamAdmin(user.id, teamId(params.ownerId));
            const home = await getTeamHome(params.ownerId);
            return home.addMount(body);
        },
        {
            body: t.Object({
                name: t.String({ minLength: 1 }),
                storageType: t.Optional(t.Union([t.Literal('local'), t.Literal('local-key'), t.Literal('s3')])),
                maxSizeMB: t.Optional(t.Number({ minimum: 10 })),
                s3Config: t.Optional(
                    t.Object({
                        endpoint: t.String(),
                        bucket: t.String(),
                        prefix: t.String(),
                        accessKeyId: t.String(),
                        secretAccessKey: t.String(),
                        region: t.Optional(t.String()),
                    }),
                ),
            }),
            auth: true,
        },
    )

    .put(
        '/team/:ownerId/mount/:mountId',
        async ({ params, body, user }) => {
            await requireTeamAdmin(user.id, teamId(params.ownerId));
            const home = await getTeamHome(params.ownerId);
            return home.updateMount(params.mountId, body);
        },
        {
            body: t.Object({
                enabled: t.Optional(t.Boolean()),
                maxSizeMB: t.Optional(t.Number({ minimum: 10 })),
                name: t.Optional(t.String({ minLength: 1 })),
                s3Config: t.Optional(
                    t.Object({
                        endpoint: t.String(),
                        bucket: t.String(),
                        prefix: t.String(),
                        accessKeyId: t.String(),
                        secretAccessKey: t.String(),
                        region: t.Optional(t.String()),
                    }),
                ),
            }),
            auth: true,
        },
    )

    .post(
        '/team/:ownerId/avatar',
        async ({ params, body, user }): Promise<string> => {
            await requireTeamAdmin(user.id, teamId(params.ownerId));
            if (!(await getTeamExists(teamId(params.ownerId)))) throw new ApiError(404, 'Team not found');
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
            await pushTeamAvatar(teamId(params.ownerId), result.data);
            // Fresh unique URL per mutation (contacts pattern) — a changed URL can never hit a
            // stale browser-cache entry, so the client shows the replacement immediately.
            return `p/avatar/${params.ownerId}?v=${randomUUID()}`;
        },
        {
            body: t.Object({ file: t.File({ format: 'image/*' }) }),
            auth: true,
        },
    )

    .delete(
        '/team/:ownerId/avatar',
        async ({ params, user }): Promise<string> => {
            await requireTeamAdmin(user.id, teamId(params.ownerId));
            if (!(await getTeamExists(teamId(params.ownerId)))) throw new ApiError(404, 'Team not found');
            await pushTeamAvatar(teamId(params.ownerId), null);
            return `p/avatar/${params.ownerId}?v=${randomUUID()}`;
        },
        { auth: true },
    );
