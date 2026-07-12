import { teamOwnerId } from '@workspace/lib/types';
import { Elysia } from 'elysia';
import { requireSelf } from '../lib/core/access';
import { ApiError } from '../lib/core/errors';
import { getHome } from '../lib/home';
import { pullCalendars, pullTeamMounts } from '../lib/home/home-relay';
import { getTeam, getTeamMembers } from '../lib/team';
import { getMemberships } from '../lib/user';
import { betterAuth } from './auth';

// Home routes are personal-only (storage size, team context)
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

            return Promise.all(
                teamIds.map(async (teamId) => {
                    const teamOwner = teamOwnerId(teamId);
                    const [team, members, mounts, calendars] = await Promise.all([
                        getTeam(teamId),
                        getTeamMembers(teamId),
                        pullTeamMounts(teamOwner).catch((err) => {
                            console.error(`[my-teams] Failed to pull mounts for ${teamId}:`, err);
                            return [];
                        }),
                        pullCalendars(teamOwner)
                            .then((cals) => cals.map((c) => ({ id: c.id, name: c.name, color: c.color })))
                            .catch((err) => {
                                // 404 = team calendar disabled (the default) — expected, not a failure
                                if (!(err instanceof ApiError && err.status === 404)) {
                                    console.error(`[my-teams] Failed to pull calendars for ${teamId}:`, err);
                                }
                                return [];
                            }),
                    ]);

                    return {
                        id: teamId,
                        name: team?.name ?? teamId,
                        members: members.map((m) => ({ email: m.user.email, name: m.user.name })),
                        mounts,
                        calendars,
                    };
                }),
            );
        },
        { auth: true },
    );
