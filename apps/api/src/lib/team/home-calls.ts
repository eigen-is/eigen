// The questions another home may ask of a team's home, such as which mounts it has, each with the handler that answers
// it on the team's Home. Callers ask through the home relay's getFromHomes. This file imports types only, which
// `bun run check` gates.

import type { MyTeam, TeamQuotaOverrides } from '@workspace/lib/types/settings';
import type { Answerers } from '../home/home-relay';

export type TeamQueries = {
    'team:mounts': { ask: null; answer: MyTeam['mounts'] };
    'team:quota-overrides': { ask: null; answer: TeamQuotaOverrides };
};

// No handler checks a user, since their callers ask only the teams the user belongs to.
export const answerTeam: Answerers<TeamQueries> = {
    'team:mounts': (home) => {
        const mounts = Object.entries(home.settings.get().mounts ?? {}).filter(([, mount]) => mount.enabled);
        return Promise.all(
            mounts.map(async ([id, mount]) => {
                const root = await home.drive.getRootFolder(id);
                return { id, name: mount.name || id, rootPathId: root?.id ?? null };
            }),
        );
    },
    'team:quota-overrides': async (home) => home.memberOverrides,
};
