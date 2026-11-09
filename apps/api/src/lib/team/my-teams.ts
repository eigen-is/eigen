// The teams the signed-in user belongs to, each with its members, its enabled mounts and its calendars, for the apps'
// team lists. It reads the teams from the auth database and asks each team's home for the rest, so a team whose home
// fails to answer still lists, without what that home would have added. The my-teams route calls it.

import { teamOwnerId } from '@workspace/lib/types';
import type { MyTeam } from '@workspace/lib/types/settings';
import { ApiError } from '../core/errors';
import { pullCalendars, pullFromEach, pullTeamMounts } from '../home/home-relay';
import { getMemberships } from '../user';
import { getTeam, getTeamMembers } from './team';

export async function listMyTeams(userId: string): Promise<MyTeam[]> {
    const { teamIds } = await getMemberships(userId);
    const owners = teamIds.map(teamOwnerId);
    const [mounts, calendars, teams] = await Promise.all([
        pullFromEach(owners, async (owner) => [owner, await pullTeamMounts(owner)] as const),
        pullFromEach(owners, async (owner) => {
            const items = await pullCalendars(owner).catch((err) => {
                // A team's calendar is off by default, and its home answers that with a 404.
                if (err instanceof ApiError && err.status === 404) return [];
                throw err;
            });
            return [owner, items.map(({ id, name, color }) => ({ id, name, color }))] as const;
        }),
        Promise.all(teamIds.map((teamId) => Promise.all([teamId, getTeam(teamId), getTeamMembers(teamId)]))),
    ]);
    const mountsOf = new Map(mounts);
    const calendarsOf = new Map(calendars);

    return teams.map(([teamId, team, members]) => ({
        id: teamId,
        name: team?.name ?? teamId,
        members: members.map((m) => ({ email: m.user.email, name: m.user.name })),
        mounts: mountsOf.get(teamOwnerId(teamId)) ?? [],
        calendars: calendarsOf.get(teamOwnerId(teamId)) ?? [],
    }));
}
