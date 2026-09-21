import type { MountConfig } from '@workspace/lib/types/mount';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { pullTeamQuotaOverrides } from '../home/home-relay';
import { getServerSettings } from './server-settings';

export type ResolvedQuotas = {
    homeDataMax: number;
    mountMax: number;
};

export async function resolveUserQuotas(mountConfig: MountConfig, teamIds: string[]): Promise<ResolvedQuotas> {
    const settings = getServerSettings();

    const dataCandidates = [settings.quotas.mailAndContactsMaxMB];
    const mountCandidates = [mountConfig.maxSizeMB ?? settings.quotas.defaultMountMaxSizeMB];

    for (const teamId of teamIds) {
        const overrides = await pullTeamQuotaOverrides(teamOwnerId(teamId));
        if (overrides.mailAndContactsMaxMB != null) {
            dataCandidates.push(overrides.mailAndContactsMaxMB);
        }
        if (overrides.defaultMountMaxSizeMB != null) {
            mountCandidates.push(overrides.defaultMountMaxSizeMB);
        }
    }

    return {
        homeDataMax: Math.max(...dataCandidates) * 1024 * 1024,
        mountMax: Math.max(...mountCandidates) * 1024 * 1024,
    };
}
