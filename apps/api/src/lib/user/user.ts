import type { User } from 'better-auth/types';
import { eq } from 'drizzle-orm';
import { member, teamMember, user } from '../../../auth-schema.ts';
import { getAuthDrizzleDb } from '../auth/auth.ts';

export async function getUserByEmail(email: string) {
    const db = getAuthDrizzleDb();
    return (await db.select().from(user).where(eq(user.email, email.toLowerCase())).get()) as User | null;
}

export async function getUserById(id: string) {
    const db = getAuthDrizzleDb();
    return (await db.select().from(user).where(eq(user.id, id)).get()) as User | null;
}

export async function updateUser(userId: string, name: string, image: string) {
    const db = getAuthDrizzleDb();
    return await db.update(user).set({ name, image }).where(eq(user.id, userId));
}

export type Memberships = {
    orgIds: string[];
    teamIds: string[];
};

/**
 * Resolves a user's org and team memberships from the auth database.
 */
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
