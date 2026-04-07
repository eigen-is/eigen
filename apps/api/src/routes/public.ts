import type { PublicUser } from '@workspace/lib/types/public';
import { validateUsername } from '@workspace/lib/validation';
import { Elysia, t } from 'elysia';
import { auth } from '../lib/auth/auth';
import { getPublicConfig } from '../lib/config/server-config';
import { getServerSettings } from '../lib/config/server-settings';
import { setCacheHeaders } from '../lib/core/http';
import { sendMail } from '../lib/core/mailer';
import { generateFallbackSvg, getAvatarByEmailOrId, getBatchPublicInfo, getPublicInfo } from '../lib/space/public';
import { waitlistService } from '../lib/waitlist/waitlist';

export const publicRouter = new Elysia({ name: 'public' })
    .get('/p/avatar/:emailOrId', async ({ params, set }) => {
        const avatar = await getAvatarByEmailOrId(params.emailOrId);

        if (avatar) {
            setCacheHeaders(set, 86400);
            set.headers['Content-Type'] = 'image/webp';
            return avatar;
        }

        setCacheHeaders(set, 3600);
        set.headers['Content-Type'] = 'image/svg+xml';
        return await generateFallbackSvg(params.emailOrId);
    })
    .get('/p/user/:emailOrId', async ({ params }) => await getPublicInfo(params.emailOrId))
    .post('/p/users', async ({ body }): Promise<Record<string, PublicUser>> => await getBatchPublicInfo(body.ids), {
        body: t.Object({ ids: t.Array(t.String(), { maxItems: 100 }) }),
    })
    .post(
        '/p/waitlist',
        async ({ body, set }) => {
            const settings = getServerSettings();
            if (!settings.onboarding.waitlist.enabled) {
                set.status = 403;
                return { error: 'Waitlist is not enabled' };
            }
            const ok = await waitlistService.submit(body.email, body.notes);
            if (ok && settings.onboarding.waitlist.notifyEmail) {
                const email = body.email.trim().toLowerCase();
                const time = new Date().toISOString();
                sendMail({
                    to: [{ name: '', address: settings.onboarding.waitlist.notifyEmail }],
                    subject: 'New Eigen Waitlist Signup',
                    text: `New waitlist signup:\n\nEmail: <${email}>\nNotes: ${body.notes}\n\nTime: ${time}`,
                    html: `<h2>New Waitlist Signup</h2><p><strong>Email:</strong> ${email}</p><p><strong>Notes:</strong> ${body.notes}</p><p><strong>Time:</strong> ${time}</p>`,
                }).catch(() => {});
            }
            return ok;
        },
        { body: t.Object({ email: t.String(), notes: t.String() }) },
    )
    .get('/p/invite/:token', async ({ params }) => {
        const entry = await waitlistService.validateToken(params.token);
        if (!entry) return { valid: false };
        const config = await getPublicConfig();
        return { valid: true, email: entry.email, orgName: config?.orgName ?? '', domain: config?.domain ?? '' };
    })
    .post(
        '/p/invite/:token/register',
        async ({ params, body, set }) => {
            const entry = await waitlistService.validateToken(params.token);
            if (!entry) {
                set.status = 400;
                return { error: 'Invalid or expired invite link' };
            }

            const usernameError = validateUsername(body.username.toLowerCase());
            if (usernameError) {
                set.status = 400;
                return { error: usernameError };
            }

            const config = await getPublicConfig();
            const email = `${body.username.toLowerCase()}@${config?.domain ?? 'localhost'}`;

            try {
                const created = await auth.api.createUser({
                    body: { name: body.name, email, password: body.password, role: 'user' },
                });
                if (!created?.user) {
                    set.status = 400;
                    return { error: 'Failed to create account' };
                }
                await waitlistService.markRegistered(params.token, created.user.id);

                const session = await auth.api.signInEmail({ body: { email, password: body.password } });
                if (session?.headers) {
                    for (const [key, value] of session.headers.entries()) {
                        if (key.toLowerCase() === 'set-cookie') {
                            set.headers['set-cookie'] = value;
                        }
                    }
                }
                return { success: true };
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to create account';
                set.status = 400;
                return { error: message };
            }
        },
        {
            body: t.Object({
                name: t.String({ minLength: 1 }),
                username: t.String({ minLength: 2 }),
                password: t.String({ minLength: 8 }),
            }),
        },
    )
    .get('/p/config', async () => {
        const config = await getPublicConfig();
        const settings = getServerSettings();
        return { ...config, waitlistEnabled: settings.onboarding?.waitlist?.enabled ?? false };
    });
