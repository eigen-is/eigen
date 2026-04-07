import { Elysia, t } from 'elysia';
import { getPublicConfig } from '../lib/config/server-config';
import { getServerSettings } from '../lib/config/server-settings';
import { requireAdmin } from '../lib/core/access';
import { ApiError } from '../lib/core/errors';
import { sendMail } from '../lib/core/mailer';
import { waitlistService } from '../lib/waitlist/waitlist';
import { betterAuth } from './auth';

function requireWaitlistEnabled() {
    const settings = getServerSettings();
    if (!settings.onboarding.waitlist.enabled) {
        throw new ApiError(403, 'Waitlist is not enabled');
    }
}

function buildInviteEmail(entry: { email: string; inviteToken: string | null }) {
    const settings = getServerSettings();
    const config = getPublicConfig();
    const template = settings.onboarding.inviteEmail;
    const inviteLink = `https://${config?.domain ?? 'localhost'}/space/signup?token=${entry.inviteToken}`;

    const replacePlaceholders = (text: string) =>
        text
            .replace(/\{email\}/g, entry.email)
            .replace(/\{orgName\}/g, config?.orgName ?? 'Eigen')
            .replace(/\{domain\}/g, config?.domain ?? 'localhost')
            .replace(/\{inviteLink\}/g, inviteLink);

    return {
        to: [{ name: '', address: entry.email }],
        subject: replacePlaceholders(template.subject),
        text: replacePlaceholders(template.body),
    };
}

export const waitlistRouter = new Elysia({ name: 'waitlist' })
    .use(betterAuth)

    .get(
        '/waitlist/:ownerId/entries',
        async ({ user, query }) => {
            await requireAdmin(user.id);
            requireWaitlistEnabled();
            return waitlistService.list(query.status || undefined);
        },
        {
            auth: true,
            query: t.Object({ status: t.Optional(t.String()) }),
        },
    )

    .put(
        '/waitlist/:ownerId/entries/:id/accept',
        async ({ user, params }) => {
            await requireAdmin(user.id);
            requireWaitlistEnabled();
            const entry = await waitlistService.accept(params.id);
            if (!entry) throw new ApiError(400, 'Entry cannot be accepted');
            sendMail(buildInviteEmail(entry)).catch(() => {});
            return entry;
        },
        { auth: true },
    )

    .put(
        '/waitlist/:ownerId/entries/:id/reject',
        async ({ user, params }) => {
            await requireAdmin(user.id);
            requireWaitlistEnabled();
            const ok = await waitlistService.reject(params.id);
            if (!ok) throw new ApiError(400, 'Entry cannot be rejected');
            return { success: true };
        },
        { auth: true },
    )

    .put(
        '/waitlist/:ownerId/entries/:id/resend',
        async ({ user, params }) => {
            await requireAdmin(user.id);
            requireWaitlistEnabled();
            const entry = await waitlistService.resendInvite(params.id);
            if (!entry) throw new ApiError(400, 'Entry is not in invited state');
            sendMail(buildInviteEmail(entry)).catch(() => {});
            return entry;
        },
        { auth: true },
    )

    .delete(
        '/waitlist/:ownerId/entries/:id',
        async ({ user, params }) => {
            await requireAdmin(user.id);
            requireWaitlistEnabled();
            await waitlistService.remove(params.id);
            return { success: true };
        },
        { auth: true },
    );
