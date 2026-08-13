import type { AdminUser } from '@workspace/lib/types/admin';
import type { S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult, ServerSettings } from '@workspace/lib/types/settings';
import { and, eq, ne, notInArray } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { member, user } from '../../auth-schema';
import { getAuthDrizzleDb } from '../lib/auth/auth';
import { getS3Config, getServerSettings, updateServerSettings } from '../lib/config/server-settings';
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
        async ({ user }): Promise<ServerSettings> => {
            await requireAdmin(user.id);
            return getServerSettings();
        },
        { auth: true },
    )

    .put(
        '/settings/server',
        async ({ body, user }): Promise<ServerSettings> => {
            await requireAdmin(user.id);
            if (body.defaults?.mount?.storageType === 's3') {
                const s3 = getS3Config();
                if (!s3) throw new ApiError(400, 'Cannot set storage type to S3 without a saved S3 configuration');
                const s3Result = await checkS3Connection(s3);
                if (!s3Result.ok) throw new ApiError(400, `Cannot set storage type to S3: ${s3Result.message}`);
            }
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
                onboarding: t.Optional(
                    t.Object({
                        waitlist: t.Optional(
                            t.Object({
                                enabled: t.Optional(t.Boolean()),
                            }),
                        ),
                        autoAddOwnerContact: t.Optional(t.Boolean()),
                        welcomeMail: t.Optional(
                            t.Object({
                                enabled: t.Optional(t.Boolean()),
                                subject: t.Optional(t.String()),
                                body: t.Optional(t.String()),
                            }),
                        ),
                        inviteEmail: t.Optional(
                            t.Object({
                                subject: t.Optional(t.String()),
                                body: t.Optional(t.String()),
                            }),
                        ),
                    }),
                ),
                guests: t.Optional(
                    t.Object({
                        openSignup: t.Optional(t.Boolean()),
                        inactivityDays: t.Optional(t.Number({ minimum: 1, maximum: 365 })),
                    }),
                ),
                landing: t.Optional(
                    t.Object({
                        links: t.Optional(
                            t.Array(
                                t.Object({
                                    title: t.String({ minLength: 1, maxLength: 80 }),
                                    url: t.String({ minLength: 1, maxLength: 2048, pattern: '^https?://' }),
                                }),
                                { maxItems: 20 },
                            ),
                        ),
                    }),
                ),
                notifications: t.Optional(
                    t.Object({
                        email: t.Optional(
                            t.Object({
                                guestOnAclAdd: t.Optional(t.Boolean()),
                                userOnAclAdd: t.Optional(t.Boolean()),
                                userOnCalendarInvite: t.Optional(t.Boolean()),
                                ownerOnAccessRequest: t.Optional(t.Boolean()),
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
        async ({ user }): Promise<S3Config | null> => {
            await requireAdmin(user.id);
            return getS3Config() ?? null;
        },
        { auth: true },
    )

    .put(
        '/settings/s3config',
        async ({ body, user }): Promise<S3Config | null> => {
            await requireAdmin(user.id);
            const s3Config = toS3Config(body);
            const s3Result = await checkS3Connection(s3Config);
            if (!s3Result.ok) throw new ApiError(400, `S3 connection failed: ${s3Result.message}`);
            await updateServerSettings({ defaults: { mount: { s3Config } } });
            return getS3Config() ?? null;
        },
        { body: s3ConfigBody, auth: true },
    )

    .get(
        '/settings/users/:filter',
        async ({ params, user: authUser }): Promise<AdminUser[]> => {
            await requireAdmin(authUser.id);
            const db = getAuthDrizzleDb();
            // Project explicitly so the wire payload matches AdminUser exactly — `select()`
            // would ship banReason / twoFactorEnabled / banned etc. to the admin UI.
            const fields = {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                createdAt: user.createdAt,
            };
            const memberUserIds = db.select({ userId: member.userId }).from(member);
            return params.filter === 'guest'
                ? db.select(fields).from(user).where(eq(user.role, 'guest')).all()
                : db
                      .select(fields)
                      .from(user)
                      .where(and(notInArray(user.id, memberUserIds), ne(user.role, 'guest')))
                      .all();
        },
        { auth: true },
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
        async ({ body, user }): Promise<S3CheckResult> => {
            await requireAdmin(user.id);
            return checkS3Connection(toS3Config(body));
        },
        { body: s3ConfigBody, auth: true },
    );
