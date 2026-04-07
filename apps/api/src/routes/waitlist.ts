import { Elysia, t } from 'elysia';
import { requireAdmin } from '../lib/core/access';
import { ApiError } from '../lib/core/errors';
import { sendMail } from '../lib/core/mailer';
import {
    acceptWaitlistEntry,
    buildInviteEmail,
    listWaitlist,
    rejectWaitlistEntry,
    removeWaitlistEntry,
    requireWaitlistEnabled,
    resendWaitlistInvite,
} from '../lib/waitlist/waitlist';
import { betterAuth } from './auth';

export const waitlistRouter = new Elysia({ name: 'waitlist' })
    .use(betterAuth)

    .get(
        '/waitlist/:ownerId/entries',
        async ({ user, query }) => {
            await requireAdmin(user.id);
            requireWaitlistEnabled();
            return listWaitlist(query.status || undefined);
        },
        { auth: true, query: t.Object({ status: t.Optional(t.String()) }) },
    )

    .put(
        '/waitlist/:ownerId/entries/:id/accept',
        async ({ user, params }): Promise<{ email: string; inviteToken: string }> => {
            await requireAdmin(user.id);
            requireWaitlistEnabled();
            const entry = await acceptWaitlistEntry(params.id);
            if (!entry) throw new ApiError(400, 'Entry cannot be accepted');
            sendMail(buildInviteEmail(entry)).catch(() => {});
            return { email: entry.email, inviteToken: entry.inviteToken };
        },
        { auth: true },
    )

    .put(
        '/waitlist/:ownerId/entries/:id/reject',
        async ({ user, params }) => {
            await requireAdmin(user.id);
            requireWaitlistEnabled();
            const ok = await rejectWaitlistEntry(params.id);
            if (!ok) throw new ApiError(400, 'Entry cannot be rejected');
            return { success: true };
        },
        { auth: true },
    )

    .put(
        '/waitlist/:ownerId/entries/:id/resend',
        async ({ user, params }): Promise<{ email: string; inviteToken: string }> => {
            await requireAdmin(user.id);
            requireWaitlistEnabled();
            const entry = await resendWaitlistInvite(params.id);
            if (!entry) throw new ApiError(400, 'Entry is not in invited state');
            sendMail(buildInviteEmail(entry)).catch(() => {});
            return { email: entry.email, inviteToken: entry.inviteToken };
        },
        { auth: true },
    )

    .delete(
        '/waitlist/:ownerId/entries/:id',
        async ({ user, params }) => {
            await requireAdmin(user.id);
            requireWaitlistEnabled();
            await removeWaitlistEntry(params.id);
            return { success: true };
        },
        { auth: true },
    );
