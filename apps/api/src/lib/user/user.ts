// The User type and the lookups of the server-wide users database: a user by email or id, their org and team
// memberships, their org role and the org's admins and owner. Routes, homes and the auth hooks read users here.

import { and, eq, inArray } from 'drizzle-orm';
import { member, teamMember, user } from '../../../auth-schema';
import type { auth } from '../auth/auth';
import { getAuthDrizzleDb } from '../auth/auth';
import { getServerConfig } from '../config/server-config';

// The better-auth session user with its plugin columns, such as role and twoFactorEnabled. It is inferred from the
// configured `auth`, so it follows the plugins and matches what getSession hands the route handlers.
export type User = typeof auth.$Infer.Session.user;

// A guest is an account with the role 'guest', signed in by an emailed code. A missing user is not a guest.
export function isGuest(user: Pick<User, 'role'> | null | undefined): boolean {
    return user?.role === 'guest';
}

// Actor display: name, else email local-part, else undefined (callers guard the undefined case).
export const actorDisplayName = (name?: string | null, email?: string | null): string | undefined =>
    name ?? email?.split('@')[0];

export async function getUserByEmail(email: string): Promise<User | null> {
    const db = getAuthDrizzleDb();
    return (await db.select().from(user).where(eq(user.email, email.toLowerCase())).get()) ?? null;
}

export async function getUserById(id: string): Promise<User | null> {
    const db = getAuthDrizzleDb();
    return (await db.select().from(user).where(eq(user.id, id)).get()) ?? null;
}

export async function updateUser(userId: string, name: string, image: string) {
    const db = getAuthDrizzleDb();
    return await db.update(user).set({ name, image }).where(eq(user.id, userId));
}

// Synthetic User for non-authenticatable owners (Org and Team Homes) that hold
// resources but never sign in. Only `id`, `name`, and `email` carry meaning; the
// rest are nulled out to satisfy the type — they're never read.
export function makeSyntheticUser(id: string, name: string, email: string): User {
    const now = new Date();
    return {
        id,
        name,
        email,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
        twoFactorEnabled: null,
        banned: null,
    };
}

export type Memberships = {
    orgIds: string[];
    teamIds: string[];
};

export async function getMemberships(userId: string): Promise<Memberships> {
    const db = getAuthDrizzleDb();

    const orgMembers = await db.select().from(member).where(eq(member.userId, userId)).all();
    const teamMembers = await db.select().from(teamMember).where(eq(teamMember.userId, userId)).all();

    return {
        orgIds: orgMembers.map((m) => m.organizationId),
        teamIds: teamMembers.map((m) => m.teamId),
    };
}

export async function getOrgRole(userId: string): Promise<string | null> {
    // Scope to the default org (config.orgId, pinned at setup). A user can self-create a second
    // org and become its 'owner'; a lookup that isn't org-scoped could return that role and pass
    // the instance-wide requireAdmin check. Scoping to the pinned id (not "the first org row",
    // whose order is unspecified) stays correct even if a stray second org exists.
    const orgId = getServerConfig()?.orgId;
    if (!orgId) return null;
    const db = getAuthDrizzleDb();
    const row = await db
        .select({ role: member.role })
        .from(member)
        .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
        .get();
    return row?.role ?? null;
}

export async function getOrgAdmins(): Promise<User[]> {
    // Scope to the default org — same reason as getOrgRole; owners and admins are the server admins.
    const orgId = getServerConfig()?.orgId;
    if (!orgId) return [];
    const db = getAuthDrizzleDb();
    const rows = await db
        .select({ user })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(eq(member.organizationId, orgId), inArray(member.role, ['admin', 'owner'])))
        .all();
    return rows.map((row) => row.user);
}

export async function getOrgOwner(): Promise<User | null> {
    // Scope to the default org — same reason as getOrgRole: a self-created org's owner must not
    // be returned as the instance owner.
    const orgId = getServerConfig()?.orgId;
    if (!orgId) return null;
    const db = getAuthDrizzleDb();
    const ownerMember = await db
        .select({ userId: member.userId })
        .from(member)
        .where(and(eq(member.organizationId, orgId), eq(member.role, 'owner')))
        .get();
    if (!ownerMember) return null;
    return getUserById(ownerMember.userId);
}
