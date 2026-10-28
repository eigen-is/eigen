// Sets a user's password without the old one. resetUserPassword is an admin's or the control socket's reset: it
// signs the user out everywhere and revokes their app passwords, because those open mail and DAV without the
// password. A guest has no password to reset.

import { eq } from 'drizzle-orm';
import { apikey } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../auth/auth';
import { setCredentialPassword } from '../auth/credential-password';
import { ApiError } from '../core/errors';
import { isGuest } from './guest';
import type { User } from './user';
import { getUserByEmail } from './user';

// What the control socket's POST /reset-password answers with.
export type ResetPasswordResult = { email: string };

export async function resetUserPassword(email: string, password: string): Promise<User> {
    const user = await getUserByEmail(email.trim());
    if (!user) throw new ApiError(404, `No account uses ${email}.`);
    if (isGuest(user)) {
        throw new ApiError(400, `${user.email} is a guest. Guests sign in with a code by email, not a password.`);
    }
    const context = await auth.$context;
    const { minPasswordLength, maxPasswordLength } = context.password.config;
    if (password.length < minPasswordLength) {
        throw new ApiError(400, `The password needs at least ${minPasswordLength} characters.`);
    }
    if (password.length > maxPasswordLength) {
        throw new ApiError(400, `The password can have at most ${maxPasswordLength} characters.`);
    }
    await setCredentialPassword(user.id, password);
    await context.internalAdapter.deleteUserSessions(user.id);
    getAuthDrizzleDb().delete(apikey).where(eq(apikey.referenceId, user.id)).run();
    return user;
}
