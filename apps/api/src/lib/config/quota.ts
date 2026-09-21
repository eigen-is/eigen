import type { MountConfig } from '@workspace/lib/types/mount';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { pullTeamQuotaOverrides } from '../home/home-relay';
import { getServerSettings } from './server-settings';

export type ResolvedQuotas = {
    homeDataMax: number;
    mountMax: number;
};

// The mail + contacts + calendar ceiling in bytes. Its own function because it needs no mount: a team Home
// has none, and its calendar is metered against this budget like any other Home's.
export async function resolveHomeDataMax(teamIds: string[]): Promise<number> {
    const candidates = [getServerSettings().quotas.mailAndContactsMaxMB];

    for (const teamId of teamIds) {
        const overrides = await pullTeamQuotaOverrides(teamOwnerId(teamId));
        if (overrides.mailAndContactsMaxMB != null) {
            candidates.push(overrides.mailAndContactsMaxMB);
        }
    }

    return Math.max(...candidates) * 1024 * 1024;
}

export async function resolveUserQuotas(mountConfig: MountConfig, teamIds: string[]): Promise<ResolvedQuotas> {
    const mountCandidates = [mountConfig.maxSizeMB ?? getServerSettings().quotas.defaultMountMaxSizeMB];

    for (const teamId of teamIds) {
        const overrides = await pullTeamQuotaOverrides(teamOwnerId(teamId));
        if (overrides.defaultMountMaxSizeMB != null) {
            mountCandidates.push(overrides.defaultMountMaxSizeMB);
        }
    }

    return {
        homeDataMax: await resolveHomeDataMax(teamIds),
        mountMax: Math.max(...mountCandidates) * 1024 * 1024,
    };
}
