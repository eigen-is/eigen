// The User type and the lookups in the server-wide users database, such as a user by email or id, their org and
// team memberships and their org role. Routes, homes and the auth hooks read users through here.

import { and, eq, inArray } from 'drizzle-orm';
import { member, teamMember, user } from '../../../auth-schema';
import type { auth } from '../auth/auth';
import { getAuthDrizzleDb } from '../auth/auth';
import { getServerConfig } from '../config/server-config';

// The better-auth session user with its plugin columns, such as role and twoFactorEnabled. It is inferred from the
// configured `auth`, so it follows the plugins and matches what getSession hands the route handlers.
export type User = typeof auth.$Infer.Session.user;

// Actor display: name, else email local-part, else undefined (callers guard the undefined case).
export const actorDisplayName = (name?: string | null, email?: string | null): string | undefined =>
    name ?? email?.split('@')[0];

export async function getUserByEmail(email: string): Promise<User | null> {
    const db = getAuthDrizzleDb();
    return (await db.select().from(user).where(eq(user.email, email.toLowerCase())).get()) ?? null;
}

// One query for many addresses, such as everyone a change is relayed to. An address without an account
// has no row.
export async function getUsersByEmails(emails: string[]): Promise<User[]> {
    if (emails.length === 0) return [];
    const db = getAuthDrizzleDb();
    return db
        .select()
        .from(user)
        .where(
            inArray(
                user.email,
                emails.map((email) => email.toLowerCase()),
            ),
        )
        .all();
}

export async function getUserById(id: string): Promise<User | null> {
    const db = getAuthDrizzleDb();
    return (await db.select().from(user).where(eq(user.id, id)).get()) ?? null;
}

export async function updateUser(userId: string, name: string, image: string): Promise<void> {
    const db = getAuthDrizzleDb();
    await db.update(user).set({ name, image }).where(eq(user.id, userId));
}

// An org or team home holds resources but never signs in, so it gets a synthetic User. Only the id, the name
// and the email mean anything. The other fields are filled to satisfy the type and are never read.
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
    // The role in the default org is the server-wide role that requireAdmin checks. The lookup names the org
    // pinned at setup, because the order of member rows is unspecified if a stray second org exists.
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
    // The owners and admins of the default org are the server admins.
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
    // The owner of the default org is the owner of the server.
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
