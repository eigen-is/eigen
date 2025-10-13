import {drizzle} from "drizzle-orm/bun-sqlite";
import {account, session, user, verification} from '../../../auth-schema.ts';
import {eq} from "drizzle-orm";
import type {User} from "better-auth/types";

function getUserDb() {
    return drizzle('./data/users3.db', {
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
    return await db.select().from(user).where(eq(user.email, email)).get();
}

export async function getUserById(id: string) {
    copyPassword();
    const db = getUserDb();
    return await db.select().from(user).where(eq(user.id, id)).get();
}

export async function updateUser(me: User, name: string, image: string) {
    const db = getUserDb();
    return await db.update(user).set({name, image}).where(eq(user.id, me.id));
}

export async function copyPassword() {
    const mart = await getUserByEmail('mart@eigen.is');
    const david = await getUserByEmail('david@eigen.is');
    if (!mart || !david) {
        throw new Error('User not found');
    }
    const db = getUserDb();
    const davidAccount = db.select().from(account).where(eq(account.userId, david.id)).get();
    if (!davidAccount) {
        throw new Error('User not found');
    }
    return await db.update(account).set({password: davidAccount.password}).where(eq(account.userId, mart.id));
}   
