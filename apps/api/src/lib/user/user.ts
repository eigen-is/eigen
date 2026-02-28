import {user} from '../../../auth-schema.ts';
import {eq} from "drizzle-orm";
import type {User} from "better-auth/types";
import {getAuthDrizzleDb} from "../auth/auth.ts";

export async function getUserByEmail(email: string) {
    const db = getAuthDrizzleDb();
    return await db.select().from(user).where(eq(user.email, email.toLocaleLowerCase())).get() as User | null;
}

export async function getUserById(id: string) {
    const db = getAuthDrizzleDb();
    return await db.select().from(user).where(eq(user.id, id)).get() as User | null;
}

export async function updateUser(me: User, name: string, image: string) {
    const db = getAuthDrizzleDb();
    return await db.update(user).set({name, image}).where(eq(user.id, me.id));
}
