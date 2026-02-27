import {drizzle} from "drizzle-orm/bun-sqlite";
import {account, session, user, verification} from '../../../auth-schema.ts';
import {eq} from "drizzle-orm";
import {getServerDataPath} from "../config/paths";
import type {User} from "better-auth/types";

function getUserDb() {
    return drizzle(getServerDataPath('users3.db'), {
        schema: {
            user,
            session,
            verification,
            account,
        },
    });
}

export async function getUserByEmail(email: string) {
    const db = getUserDb();
    return await db.select().from(user).where(eq(user.email, email.toLocaleLowerCase())).get() as User | null;
}

export async function getUserById(id: string) {
    // copyPassword();
    const db = getUserDb();
    return await db.select().from(user).where(eq(user.id, id)).get() as User | null;
}

export async function updateUser(me: User, name: string, image: string) {
    const db = getUserDb();
    return await db.update(user).set({name, image}).where(eq(user.id, me.id));
}
