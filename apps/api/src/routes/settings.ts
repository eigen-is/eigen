// The routes behind the Admin app's settings and users pages, such as the server settings, the S3
// configuration, the server status, the list of users and guests with their roles and teams, and a
// user's deletion or password reset. Every route needs an admin or the owner.

import { BACKUP_KEEP_MAX } from '@workspace/lib/constants/backup';
import { UPLOAD_CAP_MAX_MB } from '@workspace/lib/constants/mount';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import type { S3Config } from '@workspace/lib/types/mount';
import type {
    HomeSizeResponse,
    S3CheckResult,
    S3HardenResult,
    ServerSettings,
    ServerSettingsSaved,
} from '@workspace/lib/types/settings';
import { SERVER_STORAGE_TYPES } from '@workspace/lib/types/settings';
import { Elysia, t } from 'elysia';
import { requireAdmin, requireOwner } from '../lib/auth/access';
import { resolveBackupUpload, withoutBackupSecret } from '../lib/backup/upload';
import { getOrgName } from '../lib/config/server-config';
import {
    getS3Config,
    getServerSettings,
    getServerSettingsForAdmin,
    updateServerSettings,
} from '../lib/config/server-settings';
import type { ControlStatus } from '../lib/config/server-status';
import { getServerStatus } from '../lib/config/server-status';
import { ApiError } from '../lib/core';
import { sendMailOrThrow, storedSender } from '../lib/mailer/mailer';
import { renameOrganization } from '../lib/org';
import { checkS3Connection, hardenS3Bucket } from '../lib/storage/s3-storage';
import { getOrgRole, getUserById } from '../lib/user';
import { getAdminGuestRows, getAdminUserRows, getAllUsersUsage } from '../lib/user/admin-users';
import { deleteUserCompletely } from '../lib/user/delete-user';
import { resetUserPassword } from '../lib/user/reset-password';
import { betterAuth } from './auth';
import {
    optionalEnum,
    s3ConfigBody,
    s3DestinationBody,
    s3HardenBody,
    senderAddressSchema,
    senderNameSchema,
    toS3Config,
} from './shared-schemas';

// t.Integer is a union with a numeric string, whose default 422 dumps both branches; `error` replaces it.
const backupKeepSchema = t.Integer({
    minimum: 1,
    maximum: BACKUP_KEEP_MAX,
    error: `Backups to keep must be a whole number from 1 to ${BACKUP_KEEP_MAX}`,
});

const backupSettingsBody = t.Object({
    schedule: t.Optional(
        t.Object({
            enabled: t.Optional(t.Boolean()),
            hourUtc: t.Optional(
                t.Integer({
                    minimum: 0,
                    maximum: 23,
                    error: 'The backup hour must be a whole number from 0 to 23',
                }),
            ),
            withS3: t.Optional(t.Boolean()),
            keep: t.Optional(backupKeepSchema),
        }),
    ),
    upload: t.Optional(
        t.Object({
            enabled: t.Optional(t.Boolean()),
            s3: t.Optional(s3DestinationBody),
            keep: t.Optional(backupKeepSchema),
        }),
    ),
});

export const settingsRouter = new Elysia({ name: 'settings' })
    .use(betterAuth)

    .get(
        '/settings/server',
        async ({ user }): Promise<ServerSettings> => {
            await requireAdmin(user.id);
            if ((await getOrgRole(user.id)) === 'owner') return withoutBackupSecret(getServerSettings());
            return getServerSettingsForAdmin();
        },
        { auth: true },
    )

    .put(
        '/settings/server',
        async ({ body, user }): Promise<ServerSettingsSaved> => {
            await requireOwner(user.id);
            if (body.defaults?.mount?.storageType === 's3') {
                const s3 = getS3Config();
                if (!s3) throw new ApiError(400, 'Cannot set storage type to S3 without a saved S3 configuration');
                const s3Result = await checkS3Connection(s3);
                if (!s3Result.ok) throw new ApiError(400, `Cannot set storage type to S3: ${s3Result.message}`);
            }
            const mail = body.mail && { ...body.mail, ...storedSender(body.mail, getOrgName()) };
            const destination = body.backups?.upload && (await resolveBackupUpload(body.backups.upload));
            const backups = destination && { ...body.backups, upload: destination.upload };
            await updateServerSettings({ ...body, ...(mail && { mail }), ...(backups && { backups }) });
            return {
                ...withoutBackupSecret(getServerSettings()),
                ...(destination?.notice && { notice: destination.notice }),
                ...(destination?.warning && { warning: destination.warning }),
            };
        },
        {
            body: t.Object({
                quotas: t.Optional(
                    t.Object({
                        mailAndContactsMaxMB: t.Optional(t.Number({ minimum: 10 })),
                        defaultMountMaxSizeMB: t.Optional(t.Number({ minimum: 10 })),
                        maxUploadSizeMB: t.Optional(t.Number({ minimum: 1, maximum: UPLOAD_CAP_MAX_MB })),
                        trashRetentionDays: t.Optional(t.Number({ minimum: 0 })),
                    }),
                ),
                defaults: t.Optional(
                    t.Object({
                        mount: t.Optional(
                            t.Object({
                                storageType: optionalEnum(SERVER_STORAGE_TYPES),
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
                        showInstall: t.Optional(t.Boolean()),
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
                                guestOnAssign: t.Optional(t.Boolean()),
                                userOnAssign: t.Optional(t.Boolean()),
                            }),
                        ),
                    }),
                ),
                mail: t.Optional(
                    t.Object({
                        senderName: t.Optional(senderNameSchema),
                        senderAddress: t.Optional(senderAddressSchema),
                        relaySendsAsUsers: t.Optional(t.Boolean()),
                    }),
                ),
                backups: t.Optional(backupSettingsBody),
            }),
            auth: true,
        },
    )

    .get(
        '/settings/s3config',
        async ({ user }): Promise<S3Config | null> => {
            await requireOwner(user.id);
            return getS3Config() ?? null;
        },
        { auth: true },
    )

    .put(
        '/settings/s3config',
        async ({ body, user }): Promise<S3Config | null> => {
            await requireOwner(user.id);
            const s3Config = toS3Config(body);
            const s3Result = await checkS3Connection(s3Config);
            if (!s3Result.ok) throw new ApiError(400, `S3 connection failed: ${s3Result.message}`);
            await updateServerSettings({ defaults: { mount: { s3Config } } });
            return getS3Config() ?? null;
        },
        { body: s3ConfigBody, auth: true },
    )

    .get(
        '/settings/status',
        async ({ user }): Promise<ControlStatus> => {
            await requireOwner(user.id);
            return getServerStatus();
        },
        { auth: true },
    )

    // The web address and the mail domain stay as setup made them: every account is on them.
    .put(
        '/settings/organization',
        async ({ body, user, request }): Promise<{ name: string }> => {
            await requireOwner(user.id);
            return { name: await renameOrganization(body.name, request.headers) };
        },
        { body: t.Object({ name: t.String({ minLength: 1, maxLength: 100 }) }), auth: true },
    )

    // From the owner, as a share notification is, so it tests whether the relay sends as users.
    .post(
        '/settings/mail/test',
        async ({ user }): Promise<{ to: string }> => {
            await requireOwner(user.id);
            const orgName = getOrgName();
            try {
                await sendMailOrThrow({
                    from: { name: user.name, address: user.email },
                    to: [{ name: user.name, address: user.email }],
                    subject: `Test mail from ${orgName}`,
                    text: `This is a test mail from ${orgName}. It arrived, so this server can send mail.`,
                });
            } catch (error) {
                throw new ApiError(
                    502,
                    `The test mail was not sent: ${error instanceof Error ? error.message : error}`,
                );
            }
            return { to: user.email };
        },
        { auth: true },
    )

    .get(
        '/settings/users',
        async ({ user }): Promise<AdminUserRow[]> => {
            await requireAdmin(user.id);
            return getAdminUserRows();
        },
        { auth: true },
    )

    .get(
        '/settings/users/guests',
        async ({ user }): Promise<AdminUserRow[]> => {
            await requireAdmin(user.id);
            return getAdminGuestRows();
        },
        { auth: true },
    )

    .get(
        '/settings/users/usage',
        async ({ user }): Promise<Record<string, HomeSizeResponse>> => {
            await requireAdmin(user.id);
            return getAllUsersUsage();
        },
        { auth: true },
    )

    .delete(
        '/settings/user/:userId',
        async ({ params, user, request }): Promise<{ success: boolean }> => {
            await requireAdmin(user.id);
            if (params.userId === user.id) {
                throw new ApiError(400, 'Cannot delete your own account');
            }
            if ((await getOrgRole(params.userId)) === 'owner') {
                throw new ApiError(400, 'The server owner cannot be deleted');
            }
            await deleteUserCompletely(params.userId, request.headers);
            return { success: true };
        },
        { auth: true },
    )

    .put(
        '/settings/user/:userId/password',
        async ({ params, body, user }): Promise<{ success: boolean }> => {
            await requireAdmin(user.id);
            const target = await getUserById(params.userId);
            if (!target) throw new ApiError(404, 'User not found');
            if (target.id !== user.id && (await getOrgRole(target.id)) === 'owner') {
                throw new ApiError(403, "Only the owner can change the owner's password");
            }
            await resetUserPassword(target.email, body.password);
            return { success: true };
        },
        { body: t.Object({ password: t.String() }), auth: true },
    )

    .post(
        '/settings/s3check',
        async ({ body, user }): Promise<S3CheckResult> => {
            await requireAdmin(user.id);
            return checkS3Connection(toS3Config(body));
        },
        { body: s3ConfigBody, auth: true },
    )

    .post(
        '/settings/s3harden',
        async ({ body, user }): Promise<S3HardenResult> => {
            await requireAdmin(user.id);
            return hardenS3Bucket(toS3Config(body), body.noncurrentDays);
        },
        { body: s3HardenBody, auth: true },
    );
