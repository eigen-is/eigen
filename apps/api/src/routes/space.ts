// The personal settings of the signed-in user, such as the theme, mail preferences and the drive view, which
// the apps read and save. Only a full user reads or writes them, and only their own. A save sends just the
// fields it changes, and they merge into the stored settings.

import { DRIVE_SORT_KEYS } from '@workspace/lib/types/drive';
import type { UserSettings } from '@workspace/lib/types/settings';
import { DOCS_TEXT_WIDTHS, USER_THEMES } from '@workspace/lib/types/settings';
import { Elysia, t } from 'elysia';
import { requireNonGuest, requireSelf } from '../lib/auth/access';
import { getUserHome } from '../lib/home';
import { betterAuth } from './auth';
import { optionalEnum } from './shared-schemas';

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
                theme: optionalEnum(USER_THEMES),
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
                        keyboardShortcuts: t.Optional(t.Boolean()),
                        autoAdvance: t.Optional(t.Union([t.Literal('older'), t.Literal('newer'), t.Literal('list')])),
                    }),
                ),
                driveView: t.Optional(
                    t.Object({
                        mode: t.Optional(t.Union([t.Literal('list'), t.Literal('grid')])),
                        sortKey: t.Optional(t.UnionEnum(DRIVE_SORT_KEYS)),
                        sortDir: t.Optional(t.Union([t.Literal('asc'), t.Literal('desc')])),
                    }),
                ),
                celebrations: t.Optional(t.Boolean()),
                docsView: t.Optional(t.Object({ textWidth: t.Optional(t.UnionEnum(DOCS_TEXT_WIDTHS)) })),
            }),
            auth: true,
        },
    );
