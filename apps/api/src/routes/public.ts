import Elysia, { t } from 'elysia';
import { getPublicConfig } from '../lib/config/server-config.ts';
import { generateFallbackSvg, getAvatarByEmailOrId, getPublicInfo } from '../lib/space/public';
import { waitlist } from '../lib/space/waitlist';

export const publicRouter = new Elysia({ name: 'public' })
    .get('/p/avatar/:emailOrId', async ({ params, set }) => {
        const avatar = await getAvatarByEmailOrId(params.emailOrId);

        if (avatar) {
            set.headers['Cache-Control'] = 'public, max-age=86400';
            set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
            set.headers['Content-Type'] = 'image/webp';
            return avatar;
        }

        set.headers['Cache-Control'] = 'public, max-age=3600';
        set.headers['Expires'] = new Date(Date.now() + 3600000).toUTCString();
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
