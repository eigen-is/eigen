// The routes with facts about the signed-in user's own Home, such as how much storage it uses and which teams the user
// belongs to, with those teams' members, mounts and calendars. The app uses them for its storage meter and its
// team lists.

import type { HomeSizeResponse, MyTeam } from '@workspace/lib/types/settings';
import { Elysia } from 'elysia';
import { requireSelf } from '../lib/auth/access';
import { getHome } from '../lib/home';
import { listMyTeams } from '../lib/team/my-teams';
import { getMemberships } from '../lib/user';
import { betterAuth } from './auth';

export const homeRouter = new Elysia({ name: 'home' })
    .use(betterAuth)

    .get(
        '/home/:ownerId/size',
        async ({ params, user }): Promise<HomeSizeResponse> => {
            requireSelf(params.ownerId, user.id);
            const home = await getHome(user.id);
            const { teamIds } = await getMemberships(user.id);
            return await home.size(teamIds);
        },
        { auth: true },
    )

    .get(
        '/home/:ownerId/my-teams',
        async ({ params, user }): Promise<MyTeam[]> => {
            requireSelf(params.ownerId, user.id);
            return await listMyTeams(user.id);
        },
        { auth: true },
    );
