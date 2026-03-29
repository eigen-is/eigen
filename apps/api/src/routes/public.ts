import Elysia, { t } from 'elysia';
import { getPublicConfig } from '../lib/config/server-config.ts';
import { setCacheHeaders } from '../lib/core/http';
import { generateFallbackSvg, getAvatarByEmailOrId, getPublicInfo } from '../lib/space/public';
import { waitlist } from '../lib/space/waitlist';

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
    .post('/p/waitlist', async ({ body }) => await waitlist(body.email, body.notes), {
        body: t.Object({
            email: t.String(),
            notes: t.String(),
        }),
    })
    .get('/p/config', async () => getPublicConfig());
