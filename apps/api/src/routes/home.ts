// The routes with facts about the signed-in user's own Home, such as how much storage it uses and which teams the user
// belongs to, with those teams' members, mounts and calendars. The app uses them for its storage meter and its
// team lists.

import { teamOwnerId } from '@workspace/lib/types';
import { Elysia } from 'elysia';
import { requireSelf } from '../lib/auth/access';
import { ApiError } from '../lib/core/errors';
import { getHome } from '../lib/home';
import { pullCalendars, pullFromEach, pullTeamMounts } from '../lib/home/home-relay';
import { getTeam, getTeamMembers } from '../lib/team';
import { getMemberships } from '../lib/user';
import { betterAuth } from './auth';

export const homeRouter = new Elysia({ name: 'home' })
    .use(betterAuth)

    .get(
        '/home/:ownerId/size',
        async ({ params, user }) => {
            requireSelf(params.ownerId, user.id);
            const home = await getHome(user.id);
            const { teamIds } = await getMemberships(user.id);
            return await home.size(teamIds);
        },
        {
            auth: true,
        },
    )

    .get(
        '/home/:ownerId/my-teams',
        async ({ params, user }) => {
            requireSelf(params.ownerId, user.id);
            const { teamIds } = await getMemberships(user.id);
            const owners = teamIds.map(teamOwnerId);
            const [mounts, calendars] = await Promise.all([
                pullFromEach(owners, async (owner) => [owner, await pullTeamMounts(owner)] as const),
                pullFromEach(owners, async (owner) => {
                    const items = await pullCalendars(owner).catch((err) => {
                        // A team's calendar is off by default, and its home answers that with a 404.
                        if (err instanceof ApiError && err.status === 404) return [];
                        throw err;
                    });
                    return [owner, items.map(({ id, name, color }) => ({ id, name, color }))] as const;
                }),
            ]);
            const mountsOf = new Map(mounts);
            const calendarsOf = new Map(calendars);

            return Promise.all(
                teamIds.map(async (teamId) => {
                    const [team, members] = await Promise.all([getTeam(teamId), getTeamMembers(teamId)]);
                    return {
                        id: teamId,
                        name: team?.name ?? teamId,
                        members: members.map((m) => ({ email: m.user.email, name: m.user.name })),
                        mounts: mountsOf.get(teamOwnerId(teamId)) ?? [],
                        calendars: calendarsOf.get(teamOwnerId(teamId)) ?? [],
                    };
                }),
            );
        },
        { auth: true },
    );
