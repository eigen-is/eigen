// The teams the signed-in user belongs to, each with its members, its enabled mounts and its calendars, for the apps'
// team lists. It reads the teams from the auth database and asks each team's home for the rest, so a team whose home
// fails to answer still lists, without what that home would have added. The my-teams route calls it.

import { teamOwnerId } from '@workspace/lib/types';
import type { MyTeam } from '@workspace/lib/types/settings';
import { homeFolderExists } from '../config/paths';
import { getFromHomes } from '../home/home-relay';
import { getMemberships } from '../user';
import { getTeam, getTeamMembers } from './team';

export async function listMyTeams(userId: string): Promise<MyTeam[]> {
    const { teamIds } = await getMemberships(userId);
    const owners = teamIds.map(teamOwnerId);
    const [mountsOf, calendarsOf, teams] = await Promise.all([
        getFromHomes(owners, 'team:mounts', null),
        getFromHomes(owners.filter(homeFolderExists), 'calendar:calendars', null),
        Promise.all(teamIds.map((teamId) => Promise.all([teamId, getTeam(teamId), getTeamMembers(teamId)]))),
    ]);

    return teams.map(([teamId, team, members]) => ({
        id: teamId,
        name: team?.name ?? teamId,
        members: members.map((m) => ({ email: m.user.email, name: m.user.name })),
        mounts: mountsOf.get(teamOwnerId(teamId)) ?? [],
        calendars: (calendarsOf.get(teamOwnerId(teamId)) ?? []).map(({ id, name, color }) => ({ id, name, color })),
    }));
}
