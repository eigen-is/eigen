import { randomUUID } from 'node:crypto';
import { generateRandomString, hashPassword } from 'better-auth/crypto';
import { and, eq, like, lt } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { account, user as userTable, verification } from '../../auth-schema.ts';
import { auth, getAuthDrizzleDb } from '../lib/auth/auth';
import { ApiError } from '../lib/core/errors';
import { sendMail } from '../lib/core/mailer';
import { reconcileSharesForNewUser } from '../lib/share';
import { getEntriesForTarget } from '../lib/share/registry';
import { getUserByEmail } from '../lib/user/user';

// Deterministic password for guest accounts — derived from server secret + email.
// Guests never see this; they authenticate only via OTP. This exists solely so we
// can call auth.api.signInEmail to get properly signed session cookies.
function guestPassword(email: string): string {
    return `guest:${email}:${auth.options.secret}`;
}

function generateOtp(): string {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const num = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
    return String(num % 1_000_000).padStart(6, '0');
}

const emailBody = t.Object({ email: t.String() });
const verifyBody = t.Object({ email: t.String(), otp: t.String() });

export const guestAuthRouter = new Elysia({ name: 'guest-auth' })
    .post(
        '/guest-auth/request-otp',
        async ({ body }) => {
            const email = body.email.toLowerCase().trim();

            const existingUser = await getUserByEmail(email);
            if (existingUser) {
                if (existingUser.role !== 'guest') {
                    throw new ApiError(400, 'Use password login');
                }
            } else {
                const entries = await getEntriesForTarget(email);
                if (entries.length === 0) {
                    throw new ApiError(400, 'No shared resources found for this email');
                }
            }

            const db = getAuthDrizzleDb();
            const now = new Date();

            // Purge expired guest OTPs
            db.delete(verification)
                .where(and(like(verification.identifier, 'guest-otp:%'), lt(verification.expiresAt, now)))
                .run();

            const otp = generateOtp();
            const identifier = `guest-otp:${email}`;
            const hashedOtp = await Bun.password.hash(otp);
            const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);

            // Replace any existing OTP for this email
            db.delete(verification).where(eq(verification.identifier, identifier)).run();
            db.insert(verification)
                .values({
                    id: randomUUID(),
                    identifier,
                    value: hashedOtp,
                    expiresAt,
                    createdAt: now,
                    updatedAt: now,
                })
                .run();

            const ok = await sendMail({
                to: [{ name: email, address: email }],
                subject: 'Your guest access code',
                text: `Your guest access code is: ${otp}\n\nThis code expires in 5 minutes.`,
            });
            if (!ok) throw new ApiError(500, 'Failed to send verification code');

            return { success: true };
        },
        { body: emailBody },
    )
    .post(
        '/guest-auth/verify-otp',
        async ({ body }) => {
            const email = body.email.toLowerCase().trim();
            const identifier = `guest-otp:${email}`;
            const db = getAuthDrizzleDb();

            const record = db.select().from(verification).where(eq(verification.identifier, identifier)).get();

            if (!record) throw new ApiError(400, 'Invalid code');

            if (record.expiresAt < new Date()) {
                db.delete(verification).where(eq(verification.id, record.id)).run();
                throw new ApiError(400, 'Code expired');
            }

            const valid = await Bun.password.verify(body.otp, record.value);
            if (!valid) throw new ApiError(400, 'Invalid code');

            // OTP consumed — delete it
            db.delete(verification).where(eq(verification.id, record.id)).run();

            let guestUser = await getUserByEmail(email);
            let isNewUser = false;
            const password = guestPassword(email);

            if (guestUser) {
                if (guestUser.role !== 'guest') {
                    throw new ApiError(400, 'Use password login');
                }
            } else {
                const localPart = email.split('@')[0] ?? email;
                const now2 = new Date();
                const newId = generateRandomString(32);
                // Insert user directly to bypass databaseHooks (guests must not be auto-added to org)
                db.insert(userTable)
                    .values({
                        id: newId,
                        email,
                        name: localPart,
                        emailVerified: true,
                        role: 'guest',
                        createdAt: now2,
                        updatedAt: now2,
                    })
                    .run();
                guestUser = await getUserByEmail(email);
                if (!guestUser) throw new ApiError(500, 'Failed to create guest user');
                console.log(`[guest-auth] Created guest user id=${guestUser.id} email=${email}`);
                isNewUser = true;
            }

            if (isNewUser) {
                await reconcileSharesForNewUser(guestUser);
            }

            // Upsert credential account so better-auth's sign-in handler works
            const hashedPassword = await hashPassword(password);
            const existingAccount = db.select().from(account).where(eq(account.userId, guestUser.id)).get();
            if (existingAccount) {
                db.update(account)
                    .set({ password: hashedPassword, updatedAt: new Date() })
                    .where(eq(account.id, existingAccount.id))
                    .run();
            } else {
                db.insert(account)
                    .values({
                        id: generateRandomString(32),
                        accountId: guestUser.id,
                        providerId: 'credential',
                        userId: guestUser.id,
                        password: hashedPassword,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    })
                    .run();
            }

            // Sign in through better-auth's full handler pipeline — this produces
            // a Response with correctly signed session cookies, no manual forwarding.
            return auth.handler(
                new Request('http://localhost/auth/sign-in/email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password }),
                }),
            );
        },
        { body: verifyBody },
    );
