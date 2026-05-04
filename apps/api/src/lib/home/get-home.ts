import { parseOwnerId } from '@workspace/lib/types';
import { createAsyncSingleton } from '../../utils/singleton';
import { ApiError } from '../core';
import { getOrgExists } from '../org/org.ts';
import { getTeam } from '../team/team.ts';
import { getUserById } from '../user/user.ts';
import { GuestHome } from './guest-home.ts';
import type { Home } from './home';
import { getSyntheticOrgUser, OrgHome } from './org-home.ts';
import { getSyntheticTeamUser, TeamHome } from './team-home.ts';
import { UserHome } from './user-home.ts';

const homeFactories: Map<string, () => Promise<Home>> = new Map();

export function atHome(ownerId: string): boolean {
    return homeFactories.has(ownerId);
}

export async function getHome(ownerId: string): Promise<Home> {
    if (homeFactories.has(ownerId)) {
        const home = await homeFactories.get(ownerId)!();
        if (!home.destructing) {
            return home.touch();
        }
        homeFactories.delete(ownerId);
    }

    homeFactories.set(
        ownerId,
        createAsyncSingleton(async () => {
            const parsed = parseOwnerId(ownerId);
            if (!parsed) {
                throw new ApiError(400, 'Invalid ownerId format');
            }
            let home: Home;
            switch (parsed.type) {
                case 'user': {
                    const user = await getUserById(parsed.id);
                    if (!user) {
                        console.error(`[getHome] User not found for id=${parsed.id}, ownerId=${ownerId}`);
                        throw new ApiError(404, 'User not found');
                    }
                    if (user.role === 'guest') {
                        home = new GuestHome(user, () => {
                            cleanupHomeFactory(ownerId);
                        });
                    } else {
                        home = new UserHome(user, () => {
                            cleanupHomeFactory(ownerId);
                        });
                    }
                    break;
                }
                case 'team': {
                    const teamData = await getTeam(parsed.id);
                    if (!teamData) {
                        throw new ApiError(404, 'Team not found');
                    }
                    home = new TeamHome(getSyntheticTeamUser(ownerId, teamData.name), () => {
                        cleanupHomeFactory(ownerId);
                    });
                    break;
                }
                case 'external':
                    throw new ApiError(400, 'Cannot get home for external owner');
                case 'org': {
                    if (!(await getOrgExists(parsed.id))) {
                        throw new ApiError(404, 'Organization not found');
                    }
                    home = new OrgHome(getSyntheticOrgUser(ownerId), () => {
                        cleanupHomeFactory(ownerId);
                    });
                    break;
                }
                default:
                    throw new ApiError(400, 'Unsupported ownerId type');
            }
            await home.init();
            return home.touch();
        }),
    );

    return (await homeFactories.get(ownerId)!()).touch();
}

export function cleanupHomeFactory(ownerId: string): void {
    homeFactories.delete(ownerId);
}

export async function evictHome(ownerId: string): Promise<void> {
    const factory = homeFactories.get(ownerId);
    if (factory) {
        try {
            const home = await factory();
            await home.shutdown();
        } catch {
            /* Home may not be initialized */
        }
        homeFactories.delete(ownerId);
    }
}

export async function shutdownAllHomes(): Promise<void> {
    const entries = [...homeFactories.entries()];
    homeFactories.clear();
    await Promise.allSettled(
        entries.map(async ([, factory]) => {
            const home = await factory();
            await home.shutdown();
        }),
    );
}
