// Deletes what Eigen keeps for a team that is being deleted: its home with every drive's files, and the
// share-registry rows from and to it. Runs from better-auth's beforeDeleteTeam hook while the team row
// still exists, so a home that is busy with a restore or a backup keeps the team.

import { teamOwnerId } from '@workspace/lib/types/owner';
import { getTeamDataPath } from '../config/paths';
import { deleteHomeData } from '../home/delete-home';
import { removeEntriesForTarget, removeEntriesFromSource } from '../share/registry';

export async function teardownTeamData(teamId: string): Promise<void> {
    const ownerId = teamOwnerId(teamId);
    await deleteHomeData(ownerId, getTeamDataPath(teamId));
    await removeEntriesFromSource(ownerId);
    await removeEntriesForTarget(ownerId);
}
