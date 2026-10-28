// getHome is the way in to every owner's data. It builds the owner's Home on first use, keeps it in a
// cache, and hands every later caller that same Home until it closes. Because every request passes
// through here, this file also remembers when a home was last asked for, and keeps a home shut while
// a restore replaces its folder or a deletion removes it.

import { parseOwnerId } from '@workspace/lib/types/owner';
import type { AsyncSingleton } from '../../utils/singleton';
import { createAsyncSingleton } from '../../utils/singleton';
import { ApiError } from '../core';
import { getOrgExists } from '../org';
import { getTeam } from '../team';
import { getUserById, isGuest } from '../user';
import { GuestHome } from './guest-home';
import type { Home } from './home';
import { getSyntheticOrgUser, OrgHome } from './org-home';
import { getSyntheticTeamUser, TeamHome } from './team-home';
import { UserHome } from './user-home';

const homeFactories = new Map<string, AsyncSingleton<Home>>();

// When a request or a keepalive last reached each home.
const lastRequestAt = new WeakMap<Home, number>();

// Homes whose folder a restore is replacing. openHome refuses them until the restore is done, so
// nothing opens the folder while it is being moved aside.
const restoringHomes = new Set<string>();

// Homes whose owner is being deleted, from the teardown until better-auth has deleted the owner's row.
// The row and the members' sessions outlive the folder for that moment, and a request in it must not
// build a new home over the deleted folder.
const deletingHomes = new Set<string>();

export function atHome(ownerId: string): boolean {
    return homeFactories.has(ownerId);
}

// The home if it is loaded and not closing. Never opens one.
export function loadedHome(ownerId: string): Home | undefined {
    const home = homeFactories.get(ownerId)?.peek();
    return home && !home.closing ? home : undefined;
}

// A keepalive of an open connection: keeps a loaded home open, but never opens a closed one.
export function touchHomeIfLoaded(ownerId: string): void {
    const home = loadedHome(ownerId);
    if (!home) return;
    lastRequestAt.set(home, Date.now());
    home.touch();
}

// Tells work that opened a home for itself whether anybody else has used it since.
export function requestedSince(home: Home, time: number): boolean {
    return (lastRequestAt.get(home) ?? 0) >= time;
}

// The mark is the lock: a second restore of one home would move a folder aside that the first one is
// still writing, and whichever finished first would unlock the home for both.
export function markHomeRestoring(ownerId: string): void {
    if (restoringHomes.has(ownerId)) throw new ApiError(409, 'Restore already in progress');
    restoringHomes.add(ownerId);
}

export function clearHomeRestoring(ownerId: string): void {
    restoringHomes.delete(ownerId);
}

export function markHomeDeleting(ownerId: string): void {
    deletingHomes.add(ownerId);
}

// Once the owner's row is gone, or when the deletion stopped before it removed anything.
export function clearHomeDeleting(ownerId: string): void {
    deletingHomes.delete(ownerId);
}

export async function getHome(ownerId: string): Promise<Home> {
    const home = await openHome(ownerId);
    lastRequestAt.set(home, Date.now());
    return home;
}

// getHome without counting as a request, for background work such as a backup.
export async function openHome(ownerId: string): Promise<Home> {
    // Settles in one or two rounds; the limit only stops a runaway loop.
    for (let attempt = 0; attempt < 100; attempt++) {
        // Checked every round: a restore or a deletion may start while this call waits for a closing home.
        refuseShutHome(ownerId);

        const factory = homeFactories.get(ownerId) ?? installFactory(ownerId);
        let home: Home;
        try {
            home = await factory();
        } catch (err) {
            // Forget a home that failed to build, so the next call tries again.
            if (homeFactories.get(ownerId) === factory) homeFactories.delete(ownerId);
            throw err;
        }
        // Checked again: a restore or a deletion may have started while the home was being built.
        refuseShutHome(ownerId);
        if (!home.closing) return home.touch();

        // Wait until it has closed and dropped out of the cache, so the next round can't open the
        // same database files while they are still being closed.
        await home.close();
    }
    throw new Error(`openHome: could not obtain a stable home for ${ownerId}`);
}

function refuseShutHome(ownerId: string): void {
    if (restoringHomes.has(ownerId)) throw new ApiError(503, 'Restore in progress');
    if (deletingHomes.has(ownerId)) throw new ApiError(404, 'Home is being deleted');
}

function installFactory(ownerId: string): AsyncSingleton<Home> {
    const factory: AsyncSingleton<Home> = createAsyncSingleton(async () => {
        // Only drops the cache entry while it is still this home's: an old home that closes late
        // must not drop its successor.
        const onClosed = () => {
            if (homeFactories.get(ownerId) === factory) homeFactories.delete(ownerId);
        };
        const home = await createHome(ownerId, onClosed);
        try {
            await home.init();
        } catch (err) {
            // Home.init closes itself when one of its parts fails; this also covers what a kind of
            // home does before that.
            await home.close();
            throw err;
        }
        return home;
    });
    homeFactories.set(ownerId, factory);
    return factory;
}

async function createHome(ownerId: string, onClosed: () => void): Promise<Home> {
    const parsed = parseOwnerId(ownerId);
    switch (parsed.type) {
        case 'user': {
            const user = await getUserById(parsed.id);
            if (!user) {
                console.error(`[getHome] User not found for id=${parsed.id}, ownerId=${ownerId}`);
                throw new ApiError(404, 'User not found');
            }
            return isGuest(user) ? new GuestHome(user, onClosed) : new UserHome(user, onClosed);
        }
        case 'team': {
            const team = await getTeam(parsed.id);
            if (!team) throw new ApiError(404, 'Team not found');
            return new TeamHome(getSyntheticTeamUser(ownerId, team.name), onClosed);
        }
        case 'org': {
            if (!(await getOrgExists(parsed.id))) throw new ApiError(404, 'Organization not found');
            return new OrgHome(getSyntheticOrgUser(ownerId), onClosed);
        }
        case 'external':
            throw new ApiError(400, 'Cannot get home for external owner');
        case 'invalid':
            throw new ApiError(400, 'Invalid ownerId format');
    }
}

// getHome, checked to be the kind of home the caller expects.
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
    // A home that failed to build has nothing to close, and openHome forgets it.
    const home = await homeFactories
        .get(ownerId)?.()
        .catch(() => undefined);
    await home?.close();
}

export async function shutdownAllHomes(): Promise<void> {
    // Closes every home that is open now. A request that arrives meanwhile waits for its home to close
    // before it opens a new one, so the two never share database files.
    await Promise.allSettled([...homeFactories.values()].map(async (factory) => (await factory()).close()));
}
