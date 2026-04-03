import { Elysia, t } from 'elysia';
import { getS3Config, updateServerConfig } from '../lib/config/server-config';
import { getServerSettings, updateServerSettings } from '../lib/config/server-settings';
import { ApiError } from '../lib/core';
import { requireAdmin } from '../lib/core/access';
import { checkS3Connection } from '../lib/storage/s3-storage';
import { deleteUserCompletely } from '../lib/user/delete-user';
import { betterAuth } from './auth';
import { s3ConfigBody, toS3Config } from './shared-schemas';

export const settingsRouter = new Elysia({ name: 'settings' })
    .use(betterAuth)

    .get(
        '/settings/server',
        async ({ user }) => {
            await requireAdmin(user.id);
            return getServerSettings();
        },
        { auth: true },
    )

    .put(
        '/settings/server',
        async ({ body, user }) => {
            await requireAdmin(user.id);
            await updateServerSettings(body);
            return getServerSettings();
        },
        {
            body: t.Object({
                quotas: t.Optional(
                    t.Object({
                        mailAndContactsMaxMB: t.Optional(t.Number({ minimum: 10 })),
                        defaultMountMaxSizeMB: t.Optional(t.Number({ minimum: 10 })),
                        maxUploadSizeMB: t.Optional(t.Number({ minimum: 1 })),
                        maxBatchUploadSizeMB: t.Optional(t.Number({ minimum: 1 })),
                        trashRetentionDays: t.Optional(t.Number({ minimum: 1 })),
                    }),
                ),
                defaults: t.Optional(
                    t.Object({
                        mount: t.Optional(
                            t.Object({
                                storageType: t.Optional(
                                    t.Union([t.Literal('local-id'), t.Literal('local-fullnames'), t.Literal('s3')]),
                                ),
                            }),
                        ),
                    }),
                ),
            }),
            auth: true,
        },
    )

    .get(
        '/settings/s3config',
        async ({ user }) => {
            await requireAdmin(user.id);
            return getS3Config() ?? null;
        },
        { auth: true },
    )

    .put(
        '/settings/s3config',
        async ({ body, user }) => {
            await requireAdmin(user.id);
            const s3Config = toS3Config(body);
            const s3Result = await checkS3Connection(s3Config);
            if (!s3Result.ok) throw new ApiError(400, `S3 connection failed: ${s3Result.message}`);
            await updateServerConfig({ storage: { s3: s3Config } });
            return getS3Config() ?? null;
        },
        { body: s3ConfigBody, auth: true },
    )

    .delete(
        '/settings/user/:userId',
        async ({ params, user, request }) => {
            await requireAdmin(user.id);
            if (params.userId === user.id) {
                throw new ApiError(400, 'Cannot delete your own account');
            }
            await deleteUserCompletely(params.userId, request.headers);
            return { success: true };
        },
        { auth: true },
    )

    .post(
        '/settings/s3check',
        async ({ body, user }) => {
            await requireAdmin(user.id);
            return checkS3Connection(toS3Config(body));
        },
        { body: s3ConfigBody, auth: true },
    );
