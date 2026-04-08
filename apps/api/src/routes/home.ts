import { teamOwnerId } from '@workspace/lib/types';
import { Elysia } from 'elysia';
import { requireSelf } from '../lib/core/access';
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
                    const team = await getTeam(teamId);
                    const members = await getTeamMembers(teamId);
                    const teamOwner = teamOwnerId(teamId);
                    const mounts = await pullTeamMounts(teamOwner);

                    let calendars: { id: string; name: string; color: string }[] = [];
                    try {
                        calendars = (await pullCalendars(teamOwner)).map((c) => ({
                            id: c.id,
                            name: c.name,
                            color: c.color,
                        }));
                    } catch {
                        // Team calendar may be disabled
                    }

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
