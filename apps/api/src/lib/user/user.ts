import { eq } from 'drizzle-orm';
import { member, teamMember, user } from '../../../auth-schema.ts';
import { type auth, getAuthDrizzleDb } from '../auth/auth.ts';

// Canonical User type — the better-auth session user, including plugin columns
// (role, banned, twoFactorEnabled, etc.). Derived from the configured `auth`
// instance so it always tracks the active plugin set, and matches the shape
// served by `auth.api.getSession()` to Elysia route handlers.
export type User = typeof auth.$Infer.Session.user;

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
    const db = getAuthDrizzleDb();
    const row = await db.select({ role: member.role }).from(member).where(eq(member.userId, userId)).get();
    return row?.role ?? null;
}

export async function getOrgOwner(): Promise<User | null> {
    const db = getAuthDrizzleDb();
    const ownerMember = await db.select({ userId: member.userId }).from(member).where(eq(member.role, 'owner')).get();
    if (!ownerMember) return null;
    return getUserById(ownerMember.userId);
}
