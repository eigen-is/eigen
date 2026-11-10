// What the admin's Users and Guests pages list: one row per account with its org role, teams and last activity,
// read from the server-wide users database, and the storage each user's home takes. A home is sized from its folder
// and databases through pullHomeSize, without booting it. That is still disk work, so a few homes are sized at once
// and the result is cached for a few minutes.

import type { AdminUserRow } from '@workspace/lib/types/admin';
import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import type { SQL } from 'drizzle-orm';
import { eq, isNull, ne, or, sql } from 'drizzle-orm';
import { member, session, team, teamMember, user } from '../../../auth-schema';
import { Semaphore } from '../../utils/semaphore';
import { getAuthDrizzleDb } from '../auth/auth';
import { getServerConfig } from '../config/server-config';
import { pullHomeSize } from '../home/home-relay';
import { GUEST_ROLE } from './guest';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CONCURRENCY = 4;

let cache: { at: number; ids: string; data: Record<string, HomeSizeResponse> } | null = null;
let inFlight: { ids: string; promise: Promise<Record<string, HomeSizeResponse>> } | null = null;

// Everyone except guests, accounts with no org membership included.
export function getAdminUserRows(): AdminUserRow[] {
    return adminUserRows(nonGuestUsers());
}

export function getAdminGuestRows(): AdminUserRow[] {
    return adminUserRows(eq(user.role, GUEST_ROLE));
}

// A home that fails to size is left out, so one broken home does not fail the page. The cache holds one exact set
// of users: when the list grew or shrank it computes again. Calls for the same set at the same time share one
// computation.
export async function getAllUsersUsage(): Promise<Record<string, HomeSizeResponse>> {
    const userIds = getAuthDrizzleDb()
        .select({ id: user.id })
        .from(user)
        .where(nonGuestUsers())
        .all()
        .map((row) => row.id)
        .sort();
    const ids = userIds.join(',');
    if (cache && cache.ids === ids && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
    if (inFlight && inFlight.ids === ids) return inFlight.promise;
    const promise = (async () => {
        const data: Record<string, HomeSizeResponse> = {};
        const sem = new Semaphore(CONCURRENCY);
        await Promise.all(
            userIds.map((userId) =>
                sem.run(async () => {
                    try {
                        data[userId] = await pullHomeSize(userId);
                    } catch (error) {
                        console.error(`[admin-users] failed to size home ${userId}:`, error);
                    }
                }),
            ),
        );
        cache = { at: Date.now(), ids, data };
        return data;
    })();
    inFlight = { ids, promise };
    promise.finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
    });
    return promise;
}

// In SQLite `ne(user.role, GUEST_ROLE)` alone also drops a NULL role, so the NULL is ORed back in.
function nonGuestUsers(): SQL | undefined {
    return or(isNull(user.role), ne(user.role, GUEST_ROLE));
}

// A guest has no member row and no team, so it comes back with no role and no teams.
function adminUserRows(where: SQL | undefined): AdminUserRow[] {
    const db = getAuthDrizzleDb();
    const orgId = getServerConfig()?.orgId;
    // The columns are named so the admin UI never receives the others, such as banReason.
    const users = db
        .select({
            id: user.id,
            name: user.name,
            email: user.email,
            createdAt: user.createdAt,
            lastLoginAt: user.lastLoginAt,
        })
        .from(user)
        .where(where)
        .all();
    const members = orgId
        ? db
              .select({ id: member.id, userId: member.userId, role: member.role })
              .from(member)
              .where(eq(member.organizationId, orgId))
              .all()
        : [];
    // Teams belong to an org, so an unscoped join would show another org's teams here.
    const teamRows = orgId
        ? db
              .select({ userId: teamMember.userId, id: team.id, name: team.name })
              .from(teamMember)
              .innerJoin(team, eq(teamMember.teamId, team.id))
              .where(eq(team.organizationId, orgId))
              .all()
        : [];
    // MAX() over a timestamp-mode column comes back as raw epoch seconds.
    const lastSessions = db
        .select({ userId: session.userId, last: sql<number>`max(${session.updatedAt})` })
        .from(session)
        .groupBy(session.userId)
        .all();
    const memberByUser = new Map(members.map((m) => [m.userId, m]));
    const sessionByUser = new Map(lastSessions.map((s) => [s.userId, new Date(s.last * 1000)]));
    const teamsByUser = new Map<string, AdminUserRow['teams']>();
    for (const { userId, id, name } of teamRows) {
        const teams = teamsByUser.get(userId);
        if (teams) teams.push({ id, name });
        else teamsByUser.set(userId, [{ id, name }]);
    }
    return users.map((u) => {
        const m = memberByUser.get(u.id);
        const seen = [u.lastLoginAt, sessionByUser.get(u.id)].filter((d): d is Date => d != null);
        const lastActiveAt = seen.length ? new Date(Math.max(...seen.map(Number))) : null;
        return {
            id: u.id,
            name: u.name,
            email: u.email,
            memberId: m?.id ?? null,
            role: m?.role ?? null,
            createdAt: u.createdAt,
            lastActiveAt,
            teams: teamsByUser.get(u.id) ?? [],
        };
    });
}
