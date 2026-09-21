import type { MountConfig } from '@workspace/lib/types/mount';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { pullTeamQuotaOverrides, type TeamQuotaOverrides } from '../home/home-relay';
import { getServerSettings } from './server-settings';

export type ResolvedQuotas = {
    homeDataMax: number;
    mountMax: number;
};

// One relay read per team home, and every drive upload resolves quotas.
function pullOverrides(teamIds: string[]): Promise<TeamQuotaOverrides[]> {
    return Promise.all(teamIds.map((teamId) => pullTeamQuotaOverrides(teamOwnerId(teamId))));
}

function homeDataMaxOf(overrides: TeamQuotaOverrides[]): number {
    const candidates = [getServerSettings().quotas.mailAndContactsMaxMB];

    for (const override of overrides) {
        if (override.mailAndContactsMaxMB != null) {
            candidates.push(override.mailAndContactsMaxMB);
        }
    }

    return Math.max(...candidates) * 1024 * 1024;
}

// The mail + contacts + calendar ceiling in bytes. Its own function because it needs no mount: a team Home
// has none, and its calendar is metered against this budget like any other Home's.
export async function resolveHomeDataMax(teamIds: string[]): Promise<number> {
    return homeDataMaxOf(await pullOverrides(teamIds));
}

export async function resolveUserQuotas(mountConfig: MountConfig, teamIds: string[]): Promise<ResolvedQuotas> {
    const overrides = await pullOverrides(teamIds);
    const mountCandidates = [mountConfig.maxSizeMB ?? getServerSettings().quotas.defaultMountMaxSizeMB];

    for (const override of overrides) {
        if (override.defaultMountMaxSizeMB != null) {
            mountCandidates.push(override.defaultMountMaxSizeMB);
        }
    }

    return {
        homeDataMax: homeDataMaxOf(overrides),
        mountMax: Math.max(...mountCandidates) * 1024 * 1024,
    };
}
