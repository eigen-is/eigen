import type { MountConfig } from '@workspace/lib/types';
import { teamOwnerId } from '@workspace/lib/types';
import { pullTeamQuotaOverrides } from '../home/home-relay';
import { getServerSettings } from './server-settings';

export type ResolvedQuotas = {
    mailAndContactsMax: number;
    mountMax: number;
};

export async function resolveUserQuotas(mountConfig: MountConfig, teamIds: string[]): Promise<ResolvedQuotas> {
    const settings = getServerSettings();

    const mailCandidates = [settings.quotas.mailAndContactsMaxMB];
    const mountCandidates = [mountConfig.maxSizeMB ?? settings.quotas.defaultMountMaxSizeMB];

    for (const teamId of teamIds) {
        const overrides = await pullTeamQuotaOverrides(teamOwnerId(teamId));
        if (overrides.mailAndContactsMaxMB != null) {
            mailCandidates.push(overrides.mailAndContactsMaxMB);
        }
        if (overrides.defaultMountMaxSizeMB != null) {
            mountCandidates.push(overrides.defaultMountMaxSizeMB);
        }
    }

    return {
        mailAndContactsMax: Math.max(...mailCandidates) * 1024 * 1024,
        mountMax: Math.max(...mountCandidates) * 1024 * 1024,
    };
}
