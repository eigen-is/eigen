import { createHmac, randomUUID } from 'node:crypto';
import { generateId } from '@better-auth/core/utils/id';
import { hashPassword } from 'better-auth/crypto';
import { and, eq, like, lt } from 'drizzle-orm';
import { account, user as userTable, verification } from '../../../auth-schema';
import { getDomain, getOrgName } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';
import { ApiError } from '../core/errors';
import { composeOtpEmail } from '../core/mail-composers';
import { sendMail } from '../core/mailer';
import { reconcileSharesForNewUser } from '../share';
import { getEntriesForTarget } from '../share/registry';
import { getUserByEmail } from '../user/user';
import { auth, getAuthDrizzleDb } from './auth';
import { checkOtpRateLimit } from './otp-rate-limit';

const OTP_EXPIRY_MS = 5 * 60 * 1000;

function generateOtp(): string {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const num = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
    return String(num % 1_000_000).padStart(6, '0');
}

// Deterministic password nobody sees — exists so we can call auth.api.signInEmail to get a
// response with signed session cookies. Scoped per flow so the two surfaces never collide.
function scopedPassword(scope: 'guest' | 'demo', email: string): string {
    return createHmac('sha256', auth.options.secret).update(`${scope}:${email}`).digest('hex');
}

// Upsert the account's credential with the freshly derived password, then sign in and return the
// response carrying the signed session cookie. Re-deriving + overwriting on every call is
// load-bearing: it heals a tampered password so one visitor can't lock out the next.
export async function signInWithScopedPassword(
    scope: 'guest' | 'demo',
    userId: string,
    email: string,
): Promise<Response> {
    const db = getAuthDrizzleDb();
    const password = scopedPassword(scope, email);
    const hashedPassword = await hashPassword(password);
    const existingAccount = db.select().from(account).where(eq(account.userId, userId)).get();
    if (existingAccount) {
        db.update(account)
            .set({ password: hashedPassword, updatedAt: new Date() })
            .where(eq(account.id, existingAccount.id))
            .run();
    } else {
        db.insert(account)
            .values({
                id: generateId(),
                accountId: userId,
                providerId: 'credential',
                userId,
                password: hashedPassword,
                createdAt: new Date(),
                updatedAt: new Date(),
            })
            .run();
    }
    return auth.api.signInEmail({ body: { email, password }, asResponse: true });
}

export async function requestOtp(email: string, ip: string): Promise<void> {
    checkOtpRateLimit(email, ip);

    const existingUser = await getUserByEmail(email);
    if (existingUser) {
        if (existingUser.role !== 'guest') throw new ApiError(400, 'Use password login');
    } else if (!getServerSettings().guests.openSignup) {
        const entries = await getEntriesForTarget(email);
        if (entries.length === 0) throw new ApiError(400, 'No shared resources found for this email');
    }

    const db = getAuthDrizzleDb();
    const now = new Date();
    const otp = generateOtp();
    const identifier = `guest-otp:${email}`;
    // Hash before any DB writes — `Bun.password.hash` yields the event loop, and
    // doing it between the delete and insert lets a concurrent request for the same
    // email interleave (delete each other's row, both insert) and end up with two
    // live OTPs racing in the verification table.
    const hashedOtp = await Bun.password.hash(otp);

    db.transaction((tx) => {
        // Purge expired guest OTPs
        tx.delete(verification)
            .where(and(like(verification.identifier, 'guest-otp:%'), lt(verification.expiresAt, now)))
            .run();
        // Replace any existing OTP for this email
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

    const ok = await sendMail(composeOtpEmail({ name: email, email }, otp, 'guest', getOrgName(), getDomain()));
    if (!ok) throw new ApiError(500, 'Failed to send verification code');
}

export async function verifyOtpAndSignIn(email: string, otp: string): Promise<Response> {
    const db = getAuthDrizzleDb();
    const identifier = `guest-otp:${email}`;

    const record = db.select().from(verification).where(eq(verification.identifier, identifier)).get();
    if (!record) throw new ApiError(400, 'Invalid code');

    // Consume the code synchronously, before the async verify below. bun:sqlite is synchronous,
    // so this SELECT + DELETE runs in one un-interruptible tick: a second concurrent request for
    // the same code finds no row, so one OTP can never mint two sessions. A wrong or expired
    // guess also consumes the code — acceptable given the 6-digit space and 5-minute expiry.
    db.delete(verification).where(eq(verification.id, record.id)).run();

    if (record.expiresAt < new Date()) throw new ApiError(400, 'Code expired');

    const valid = await Bun.password.verify(otp, record.value);
    if (!valid) throw new ApiError(400, 'Invalid code');

    // Find or create guest user
    let guestUser = await getUserByEmail(email);
    if (guestUser && guestUser.role !== 'guest') throw new ApiError(400, 'Use password login');

    if (!guestUser) {
        const now = new Date();
        // Insert directly to bypass databaseHooks (guests must not be auto-added to org).
        // `generateId` (clean a-zA-Z0-9) — NOT `generateRandomString` (base64-url, includes
        // '_' and '-'); `parseOwnerId` only accepts alphanumeric, and a guest id with '_'
        // would fail every owner-scoped lookup.
        db.insert(userTable)
            .values({
                id: generateId(),
                email,
                name: email.split('@')[0] ?? email,
                emailVerified: true,
                role: 'guest',
                createdAt: now,
                updatedAt: now,
            })
            .run();
        guestUser = await getUserByEmail(email);
        if (!guestUser) throw new ApiError(500, 'Failed to create guest user');
    }

    // Reconcile every successful login, not just the first. The previous version only
    // ran inside the create branch, so any error after creation (including the parseOwnerId
    // bug above) left the guest's shared_paths permanently empty — the second login would
    // succeed but "Shared with me" stayed blank.
    await reconcileSharesForNewUser(guestUser);

    // Upsert credential account and return the response with the signed session cookie.
    return signInWithScopedPassword('guest', guestUser.id, email);
}
