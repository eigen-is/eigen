import type { PublicUser } from '@workspace/lib/types/public';
import { Elysia, t } from 'elysia';
import { isDemo } from '../lib/config/env';
import { getPublicConfig } from '../lib/config/server-config';
import { getServerSettings } from '../lib/config/server-settings';
import { ApiError } from '../lib/core/errors';
import { etagMatches, setCacheHeaders } from '../lib/core/http';
import { generateFallbackSvg, getAvatarByEmailOrId, getBatchPublicInfo, getPublicInfo } from '../lib/space/public';
import { registerFromInvite, submitWaitlist, validateInviteToken } from '../lib/waitlist/waitlist';

// The /p/ prefix is eigen's PUBLIC API surface — every route here is intentionally unauthenticated
// (avatar, user info, config, invite, waitlist). Do NOT add `auth: true` / `.use(betterAuth)`: these
// are consumed by pre-auth pages and external callers, and gating them breaks the public contract.
export const publicRouter = new Elysia({ name: 'public' })
    .get('/p/avatar/:emailOrId', async ({ params, set, request }) => {
        const avatar = await getAvatarByEmailOrId(params.emailOrId);

        if (avatar) {
            // Team avatars live at a stable filename, so a long TTL would pin a replaced image
            // for a day; revalidate instead (cheap 304s, and only team rows pay them). User
            // avatars keep the long TTL — member lists fetch them in bulk.
            if (params.emailOrId.startsWith('team_')) {
                const etag = `W/"${avatar.size}-${avatar.lastModified}"`;
                const ifNoneMatch = request.headers.get('if-none-match');
                if (ifNoneMatch && etagMatches(ifNoneMatch, etag.slice(2))) {
                    return new Response(null, { status: 304, headers: { ETag: etag } });
                }
                set.headers['ETag'] = etag;
                set.headers['Cache-Control'] = 'public, no-cache';
                set.headers['Content-Type'] = 'image/webp';
                return avatar;
            }
            setCacheHeaders(set, 86400, 'public');
            set.headers['Content-Type'] = 'image/webp';
            return avatar;
        }

        setCacheHeaders(set, 3600, 'public');
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
            return submitWaitlist(body.email, body.notes);
        },
        {
            body: t.Object({
                email: t.String({ maxLength: 320 }),
                notes: t.String({ maxLength: 1000 }),
            }),
        },
    )
    .get('/p/invite/:token', async ({ params }) => {
        const entry = await validateInviteToken(params.token);
        if (!entry) return { valid: false };
        const config = getPublicConfig();
        return {
            valid: true,
            email: entry.email,
            orgName: config.orgName,
            mailDomain: config.mailDomain,
        };
    })
    .post(
        '/p/invite/:token/register',
        async ({ params, body, set }) => {
            const session = await registerFromInvite(params.token, body.name, body.username, body.password);
            const setCookie = session.headers.get('set-cookie');
            if (setCookie) set.headers['set-cookie'] = setCookie;
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
        const config = getPublicConfig();
        const settings = getServerSettings();
        return { ...config, waitlistEnabled: settings.onboarding?.waitlist?.enabled ?? false, demoMode: isDemo() };
    });
