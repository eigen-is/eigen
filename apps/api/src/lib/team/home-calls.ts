// The questions another home may ask of a team's home, such as which mounts it has, each with the handler that answers
// it on the team's Home. Callers ask through the home relay's getFromHomes, and ask only the teams the user belongs to.
// The relay joins this table with its own when it loads, so this file imports types only: a value import that led back
// to the relay would find it half-built.

import type { MyTeam } from '@workspace/lib/types/settings';
import type { Answerers } from '../home/home-relay';

export type TeamQueries = {
    'team:mounts': { ask: null; answer: MyTeam['mounts'] };
};

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
};
