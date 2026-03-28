import type { MountConfig } from '@workspace/lib/types';
import { teamOwnerId } from '@workspace/lib/types';
import { getHome } from '../home';
import type { TeamHome } from '../home/team-home';
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
        const teamHome = (await getHome(teamOwnerId(teamId))) as TeamHome;
        const ts = teamHome.settings.get();
        if (ts.memberOverrides?.mailAndContactsMaxMB != null) {
            mailCandidates.push(ts.memberOverrides.mailAndContactsMaxMB);
        }
        if (ts.memberOverrides?.defaultMountMaxSizeMB != null) {
            mountCandidates.push(ts.memberOverrides.defaultMountMaxSizeMB);
        }
    }

    return {
        mailAndContactsMax: Math.max(...mailCandidates) * 1024 * 1024,
        mountMax: Math.max(...mountCandidates) * 1024 * 1024,
    };
}
