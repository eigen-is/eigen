import { eq } from 'drizzle-orm';
import { apikey } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../auth/auth';
import { ApiError } from '../core/errors';
import type { User } from './user';
import { getUserByEmail } from './user';

export async function resetUserPassword(email: string, password: string): Promise<User> {
    const user = await getUserByEmail(email.trim());
    if (!user) throw new ApiError(404, `No account uses ${email}.`);
    if (user.role === 'guest') {
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
    const hash = await context.password.hash(password);
    if (await context.internalAdapter.findCredentialAccount(user.id)) {
        await context.internalAdapter.updatePassword(user.id, hash);
    } else {
        await context.internalAdapter.createAccount({
            userId: user.id,
            providerId: 'credential',
            accountId: user.id,
            password: hash,
        });
    }
    await context.internalAdapter.deleteUserSessions(user.id);
    // App passwords open IMAP, CalDAV and WebDAV without the password, so a reset revokes them too.
    getAuthDrizzleDb().delete(apikey).where(eq(apikey.referenceId, user.id)).run();
    return user;
}
