import type { UserSettings } from '@workspace/lib/types/settings';
import { Elysia, t } from 'elysia';
import { requireNonGuest, requireSelf } from '../lib/core/access';
import { getUserHome } from '../lib/home';
import { betterAuth } from './auth';

// Space routes are personal-only (user settings)
export const spaceRouter = new Elysia({ name: 'space' })
    .use(betterAuth)

    .get(
        '/space/:ownerId/settings',
        async ({ params, user }): Promise<UserSettings> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const home = await getUserHome(user.id);
            return home.settings.get();
        },
        { auth: true },
    )

    .put(
        '/space/:ownerId/settings',
        async ({ params, body, user }): Promise<UserSettings> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const home = await getUserHome(user.id);
            return await home.settings.set(body);
        },
        {
            body: t.Object({
                theme: t.Optional(t.Union([t.Literal('light'), t.Literal('dark'), t.Literal('system')])),
                chromeStyle: t.Optional(t.Union([t.Literal('theme'), t.Literal('app')])),
                email: t.Optional(
                    t.Object({
                        signatures: t.Optional(
                            t.Array(
                                t.Object({
                                    id: t.String(),
                                    name: t.String(),
                                    html: t.String(),
                                }),
                            ),
                        ),
                    }),
                ),
            }),
            auth: true,
        },
    );
