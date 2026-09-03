import { parseOwnerId } from '@workspace/lib/types/owner';
import { type AsyncSingleton, createAsyncSingleton } from '../../utils/singleton';
import { ApiError } from '../core';
import { getOrgExists } from '../org/org';
import { getTeam } from '../team/team';
import { getUserById } from '../user/user';
import { GuestHome } from './guest-home';
import type { Home } from './home';
import { getSyntheticOrgUser, OrgHome } from './org-home';
import { getSyntheticTeamUser, TeamHome } from './team-home';
import { UserHome } from './user-home';

const homeFactories: Map<string, AsyncSingleton<Home>> = new Map();

export function atHome(ownerId: string): boolean {
    return homeFactories.has(ownerId);
}

// Resets the idle timer on an already-loaded home. peek() never triggers the factory,
// so a keepalive tick pins a live home without resurrecting an evicted one.
export function touchHomeIfLoaded(ownerId: string): void {
    homeFactories.get(ownerId)?.peek()?.touch();
}

export async function getHome(ownerId: string): Promise<Home> {
    // Retry to resolve races with a concurrently-destructing home or a competing installer. This
    // settles in one or two iterations in practice; the bound is only a runaway safety net.
    for (let attempt = 0; attempt < 100; attempt++) {
        const existing = homeFactories.get(ownerId);
        if (existing) {
            const home = await existing();
            if (!home.destructing) {
                return home.touch();
            }
            // The cached home is tearing down. Await its teardown to completion (the same shutdown()
            // path evictHome uses) BEFORE dropping it, so the replacement can't open the same DB files
            // while close() is still checkpointing + unlinking the -wal/-shm journals. shutdown() is
            // idempotent with the in-flight destruct(), so this just awaits the outgoing teardown.
            await home.shutdown();
            // Evict only if it is still the current entry — a concurrent caller may already have
            // installed a replacement we must not clobber.
            if (homeFactories.get(ownerId) === existing) {
                homeFactories.delete(ownerId);
            }
            continue;
        }

        const factory: AsyncSingleton<Home> = createAsyncSingleton(async () => {
            // Identity-checked cleanup: evict only while we are still the installed factory, so a
            // superseded/orphaned home's teardown cannot evict a live successor for the same owner.
            const cleanUp = () => {
                if (homeFactories.get(ownerId) === factory) {
                    homeFactories.delete(ownerId);
                }
            };
            const parsed = parseOwnerId(ownerId);
            if (parsed.type === 'invalid') {
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
                    home = user.role === 'guest' ? new GuestHome(user, cleanUp) : new UserHome(user, cleanUp);
                    break;
                }
                case 'team': {
                    const teamData = await getTeam(parsed.id);
                    if (!teamData) {
                        throw new ApiError(404, 'Team not found');
                    }
                    home = new TeamHome(getSyntheticTeamUser(ownerId, teamData.name), cleanUp);
                    break;
                }
                case 'external':
                    throw new ApiError(400, 'Cannot get home for external owner');
                case 'org': {
                    if (!(await getOrgExists(parsed.id))) {
                        throw new ApiError(404, 'Organization not found');
                    }
                    home = new OrgHome(getSyntheticOrgUser(ownerId), cleanUp);
                    break;
                }
            }
            await home.init();
            return home.touch();
        });

        // Install only if no factory exists; if a concurrent caller won the install race, discard
        // ours and re-loop to use theirs — honouring createAsyncSingleton's "build once" contract.
        if (homeFactories.has(ownerId)) {
            continue;
        }
        homeFactories.set(ownerId, factory);
        return (await factory()).touch();
    }
    throw new Error(`getHome: could not obtain a stable home for ${ownerId}`);
}

// Typed own-home accessors: resolve the caller's own home and assert its concrete
// subtype, so routes can drop the `(await getHome(id)) as TeamHome` casts.
export async function getTeamHome(teamOwnerId: string): Promise<TeamHome> {
    const home = await getHome(teamOwnerId);
    if (!(home instanceof TeamHome)) {
        throw new Error(`Not a team home: ${teamOwnerId}`);
    }
    return home;
}

export async function getUserHome(userId: string): Promise<UserHome> {
    const home = await getHome(userId);
    if (!(home instanceof UserHome)) {
        throw new Error(`Not a user home: ${userId}`);
    }
    return home;
}

export async function evictHome(ownerId: string): Promise<void> {
    const factory = homeFactories.get(ownerId);
    if (!factory) return;
    try {
        const home = await factory();
        await home.shutdown();
    } catch {
        /* Home may not be initialized */
    }
    // Evict only if it is still the current entry — a concurrent getHome may already have
    // installed a replacement we must not clobber.
    if (homeFactories.get(ownerId) === factory) {
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
