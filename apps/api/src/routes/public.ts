import type { PublicUser } from '@workspace/lib/types/public';
import { validateUsername } from '@workspace/lib/validation';
import { Elysia, t } from 'elysia';
import { auth } from '../lib/auth/auth';
import { getPublicConfig } from '../lib/config/server-config';
import { getServerSettings } from '../lib/config/server-settings';
import { ApiError } from '../lib/core/errors';
import { setCacheHeaders } from '../lib/core/http';
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
        async ({ body }) => {
            const settings = getServerSettings();
            if (!settings.onboarding.waitlist.enabled) {
                throw new ApiError(403, 'Waitlist is not enabled');
            }
            return waitlistService.submit(body.email, body.notes);
        },
        {
            body: t.Object({
                email: t.String({ maxLength: 320 }),
                notes: t.String({ maxLength: 1000 }),
            }),
        },
    )
    .get('/p/invite/:token', async ({ params }) => {
        const entry = await waitlistService.validateToken(params.token);
        if (!entry) return { valid: false };
        const config = getPublicConfig();
        return { valid: true, email: entry.email, orgName: config?.orgName ?? '', domain: config?.domain ?? '' };
    })
    .post(
        '/p/invite/:token/register',
        async ({ params, body, set }) => {
            const entry = await waitlistService.validateToken(params.token);
            if (!entry) throw new ApiError(400, 'Invalid or expired invite link');

            const usernameError = validateUsername(body.username.toLowerCase());
            if (usernameError) throw new ApiError(400, usernameError);

            const config = getPublicConfig();
            const email = `${body.username.toLowerCase()}@${config?.domain ?? 'localhost'}`;

            const created = await auth.api.createUser({
                body: { name: body.name, email, password: body.password, role: 'user' },
            });
            if (!created?.user) throw new ApiError(400, 'Failed to create account');

            const claimed = await waitlistService.claimToken(params.token, created.user.id);
            if (!claimed) throw new ApiError(409, 'Invite has already been used');

            const session = await auth.api.signInEmail({
                body: { email, password: body.password },
                asResponse: true,
            });
            const setCookie = session.headers.get('set-cookie');
            if (setCookie) {
                set.headers['set-cookie'] = setCookie;
            }
            return { success: true };
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
