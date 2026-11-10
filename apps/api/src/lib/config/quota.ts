// The storage limits that apply to an owner: the home-data budget for mail, contacts and calendar, and a drive's cap.
// Each is the largest of the server default and the overrides of the owner's teams, so a team only raises a limit.
// The quota checks resolve them again on every metered write, such as an upload, with one relay read per team.

import type { MountConfig } from '@workspace/lib/types/mount';
import { teamOwnerId } from '@workspace/lib/types/owner';
import type { TeamQuotaOverrides } from '../home/home-relay';
import { pullTeamQuotaOverrides } from '../home/home-relay';
import { getServerSettings } from './server-settings';

const MB = 1024 * 1024;

export type ResolvedQuotas = {
    homeDataMax: number;
    mountMax: number;
};

// Its own function because it needs no mount: a team Home has none, yet its calendar meters against this budget.
export async function resolveHomeDataMax(teamIds: string[]): Promise<number> {
    return homeDataMaxOf(await pullOverrides(teamIds));
}

// A user's drive takes the largest of its own cap, the server default and its owner's team overrides: its own cap is
// the default stamped at the first sign-in, which nothing edits after, so a raised default reaches every user. A team's
// drive keeps the cap an admin set on it, below the default too.
export async function resolveUserQuotas(
    mountConfig: MountConfig,
    teamIds: string[],
    owner: 'user' | 'team',
): Promise<ResolvedQuotas> {
    const overrides = await pullOverrides(teamIds);
    const serverDefault = getServerSettings().quotas.defaultMountMaxSizeMB;
    const mountCandidates = [
        mountConfig.maxSizeMB ?? serverDefault,
        ...(owner === 'user' ? [serverDefault] : []),
        ...overrides.flatMap((override) => override.defaultMountMaxSizeMB ?? []),
    ];
    return { homeDataMax: homeDataMaxOf(overrides), mountMax: Math.max(...mountCandidates) * MB };
}

function pullOverrides(teamIds: string[]): Promise<TeamQuotaOverrides[]> {
    return Promise.all(teamIds.map((teamId) => pullTeamQuotaOverrides(teamOwnerId(teamId))));
}

function homeDataMaxOf(overrides: TeamQuotaOverrides[]): number {
    const candidates = [
        getServerSettings().quotas.homeDataMaxMB,
        ...overrides.flatMap((override) => override.homeDataMaxMB ?? []),
    ];
    return Math.max(...candidates) * MB;
}
