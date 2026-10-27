// The admin routes for the waitlist: list the people who asked for an invitation, accept or reject them, send the
// invitation again, and remove an entry. The waitlist belongs to the whole server, so only the owner may use them,
// and their paths carry no owner id: no Home holds it.

import { Elysia, t } from 'elysia';
import { requireOwner } from '../lib/auth/access';
import { ApiError } from '../lib/core/errors';
import { sendMail } from '../lib/mailer/mailer';
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
        '/waitlist/entries',
        async ({ user, query }) => {
            await requireOwner(user.id);
            requireWaitlistEnabled();
            return listWaitlist(query.status || undefined);
        },
        { auth: true, query: t.Object({ status: t.Optional(t.String()) }) },
    )

    .put(
        '/waitlist/entries/:id/accept',
        async ({ user, params }): Promise<{ email: string; inviteToken: string }> => {
            await requireOwner(user.id);
            requireWaitlistEnabled();
            const entry = await acceptWaitlistEntry(params.id);
            if (!entry) throw new ApiError(400, 'Entry cannot be accepted');
            sendMail(buildInviteEmail(entry)).catch(() => {});
            return { email: entry.email, inviteToken: entry.inviteToken };
        },
        { auth: true },
    )

    .put(
        '/waitlist/entries/:id/reject',
        async ({ user, params }) => {
            await requireOwner(user.id);
            requireWaitlistEnabled();
            const ok = await rejectWaitlistEntry(params.id);
            if (!ok) throw new ApiError(400, 'Entry cannot be rejected');
            return { success: true };
        },
        { auth: true },
    )

    .put(
        '/waitlist/entries/:id/resend',
        async ({ user, params }): Promise<{ email: string; inviteToken: string }> => {
            await requireOwner(user.id);
            requireWaitlistEnabled();
            const entry = await resendWaitlistInvite(params.id);
            if (!entry) throw new ApiError(400, 'Entry is not in invited state');
            sendMail(buildInviteEmail(entry)).catch(() => {});
            return { email: entry.email, inviteToken: entry.inviteToken };
        },
        { auth: true },
    )

    .delete(
        '/waitlist/entries/:id',
        async ({ user, params }) => {
            await requireOwner(user.id);
            requireWaitlistEnabled();
            await removeWaitlistEntry(params.id);
            return { success: true };
        },
        { auth: true },
    );
