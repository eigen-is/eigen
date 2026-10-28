// Sign-in for guests, people without an account who were given access to something by email. A guest asks for a
// one-time code, gets it by mail and sends it back. A right code finds or creates the guest account, reconciles its
// shares and signs it in. Requesting and guessing codes are rate limited. The session itself comes from
// signInWithScopedPassword, which the demo entry shares.

import { randomUUID } from 'node:crypto';
import { generateId } from '@better-auth/core/utils/id';
import { and, eq, like, lt } from 'drizzle-orm';
import { user as userTable, verification } from '../../../auth-schema';
import { getDomain, getOrgName, isInternalAddress } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';
import { ApiError } from '../core/errors';
import { composeOtpEmail } from '../mailer/mail-composers';
import { sendMail } from '../mailer/mailer';
import { getEntriesForTarget, reconcileSharesForNewUser } from '../share';
import { GUEST_ROLE, isGuest } from '../user/guest';
import { getUserByEmail } from '../user/user';
import { auth, getAuthDrizzleDb } from './auth';
import { checkOtpRateLimit, countOtpGuess, refundOtpRequests, resetOtpGuesses } from './otp-rate-limit';

const OTP_EXPIRY_MS = 5 * 60 * 1000;

function generateOtp(): string {
    const num = new DataView(crypto.getRandomValues(new Uint8Array(4)).buffer).getUint32(0);
    return String(num % 1_000_000).padStart(6, '0');
}

// Writes a password derived from the scope and the email onto the credential account, then signs in with it and
// returns the response that carries the session cookie. The password is written on every call, so one that was
// changed heals, and one visitor cannot lock out the next.
export async function signInWithScopedPassword(
    scope: 'guest' | 'demo',
    userId: string,
    email: string,
): Promise<Response> {
    // Nobody sees it: it only lets auth.api.signInEmail sign the cookie. Scoped so the two flows never collide.
    const password = new Bun.CryptoHasher('sha256', auth.options.secret).update(`${scope}:${email}`).digest('hex');
    const context = await auth.$context;
    const hash = await context.password.hash(password);
    if (await context.internalAdapter.findCredentialAccount(userId)) {
        await context.internalAdapter.updatePassword(userId, hash);
    } else {
        await context.internalAdapter.createAccount({
            userId,
            providerId: 'credential',
            accountId: userId,
            password: hash,
        });
    }
    return auth.api.signInEmail({ body: { email, password }, asResponse: true });
}

export async function requestOtp(email: string, ip: string): Promise<void> {
    checkOtpRateLimit(email, ip);

    const existingUser = await getUserByEmail(email);
    if (existingUser) {
        if (!isGuest(existingUser)) throw new ApiError(400, 'Use password login');
    } else {
        // A direct insert bypasses the auth hook, so refuse a guest on our own mail domain here.
        if (isInternalAddress(email)) throw new ApiError(400, 'Not a guest address');
        if (!getServerSettings().guests.openSignup) {
            const entries = await getEntriesForTarget(email);
            if (entries.length === 0) throw new ApiError(400, 'No shared resources found for this email');
        }
    }

    const db = getAuthDrizzleDb();
    const now = new Date();
    const otp = generateOtp();
    const identifier = `guest-otp:${email}`;
    // Hash before the transaction. Bun.password.hash yields the event loop, so hashing between the delete and the
    // insert would let two requests for one email both insert, leaving two live codes.
    const hashedOtp = await Bun.password.hash(otp);

    db.transaction((tx) => {
        // Expired codes of every guest go too.
        tx.delete(verification)
            .where(and(like(verification.identifier, 'guest-otp:%'), lt(verification.expiresAt, now)))
            .run();
        tx.delete(verification).where(eq(verification.identifier, identifier)).run();
        tx.insert(verification)
            .values({
                id: randomUUID(),
                identifier,
                value: hashedOtp,
                expiresAt: new Date(now.getTime() + OTP_EXPIRY_MS),
                createdAt: now,
                updatedAt: now,
            })
            .run();
    });

    resetOtpGuesses(email);

    const ok = await sendMail(composeOtpEmail({ name: email, email }, otp, 'guest', getOrgName(), getDomain()));
    if (!ok) throw new ApiError(500, 'Failed to send verification code');
}

export async function verifyOtpAndSignIn(email: string, otp: string, ip: string): Promise<Response> {
    const db = getAuthDrizzleDb();
    const identifier = `guest-otp:${email}`;

    const record = db.select().from(verification).where(eq(verification.identifier, identifier)).get();
    if (!record) throw new ApiError(400, 'Invalid code');

    if (record.expiresAt < new Date()) {
        db.delete(verification).where(eq(verification.id, record.id)).run();
        throw new ApiError(400, 'Code expired');
    }

    // Counted before the async verify, so a burst of parallel guesses can't outrun the cap.
    if (!countOtpGuess(email, record.expiresAt)) {
        db.delete(verification).where(eq(verification.id, record.id)).run();
        throw new ApiError(429, 'Too many wrong attempts — request a new code');
    }

    const valid = await Bun.password.verify(otp, record.value);
    if (!valid) throw new ApiError(400, 'Invalid code');

    // bun:sqlite is synchronous, so of two requests with the right code only one deletes the row, and one code
    // cannot mint two sessions.
    const consumed = db
        .delete(verification)
        .where(eq(verification.id, record.id))
        .returning({ id: verification.id })
        .all();
    if (consumed.length === 0) throw new ApiError(400, 'Invalid code');
    resetOtpGuesses(email);
    refundOtpRequests(email, ip);

    let guestUser = await getUserByEmail(email);
    if (guestUser && !isGuest(guestUser)) throw new ApiError(400, 'Use password login');

    if (!guestUser) {
        const now = new Date();
        // A direct insert skips better-auth's user hooks, so a guest joins no org. The id comes from generateId,
        // which is plain letters and digits: parseOwnerId accepts nothing else, and generateRandomString can give
        // '_' or '-'.
        db.insert(userTable)
            .values({
                id: generateId(),
                email,
                name: email.split('@')[0] ?? email,
                emailVerified: true,
                role: GUEST_ROLE,
                createdAt: now,
                updatedAt: now,
            })
            .run();
        guestUser = await getUserByEmail(email);
        if (!guestUser) throw new ApiError(500, 'Failed to create guest user');
    }

    // Every sign-in reconciles, not only the first, so a first reconcile that failed heals at the next sign-in.
    await reconcileSharesForNewUser(guestUser);

    return signInWithScopedPassword('guest', guestUser.id, email);
}
