import type { UserSettings } from '@workspace/lib/types/settings';
import { Elysia, t } from 'elysia';
import { requireSelf } from '../lib/core/access';
import type { UserHome } from '../lib/home';
import { getHome } from '../lib/home';
import { betterAuth } from './auth';

// Space routes are personal-only (user settings)
export const spaceRouter = new Elysia({ name: 'space' })
    .use(betterAuth)

    .get(
        '/space/:ownerId/settings',
        async ({ params, user }): Promise<UserSettings> => {
            requireSelf(params.ownerId, user.id);
            const home = (await getHome(user.id)) as UserHome;
            return home.settings.get();
        },
        { auth: true, noGuest: true },
    )

    .put(
        '/space/:ownerId/settings',
        async ({ params, body, user }): Promise<UserSettings> => {
            requireSelf(params.ownerId, user.id);
            const home = (await getHome(user.id)) as UserHome;
            return await home.settings.set(body);
        },
        {
            body: t.Object({
                theme: t.Optional(t.Union([t.Literal('light'), t.Literal('dark'), t.Literal('system')])),
            }),
            auth: true,
            noGuest: true,
        },
    );
