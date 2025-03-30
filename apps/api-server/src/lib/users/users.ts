import {drizzle} from "drizzle-orm/bun-sqlite";
import {account, session, user, verification} from '../../../auth-schema.ts';
import {eq} from "drizzle-orm";

export async function getUserByEmail(email: string) {
    const db = drizzle('./data/users3.db', {
        schema: {
            user,
            session,
            verification,
            account,
        },
    });
    return await db.select().from(user).where(eq(user.email, email)).get();
}

export async function getUserById(id: string) {
    const db = drizzle('./data/users3.db', {
        schema: {
            user,
            session,
            verification,
            account,
        },
    });
    return await db.select().from(user).where(eq(user.id, id)).get();
}