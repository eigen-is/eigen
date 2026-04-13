import { randomUUID } from 'node:crypto';
import { and, eq, like, lt } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { session, verification } from '../../auth-schema.ts';
import { auth, getAuthDrizzleDb } from '../lib/auth/auth';
import { ApiError } from '../lib/core/errors';
import { sendMail } from '../lib/core/mailer';
import { reconcileSharesForNewUser } from '../lib/share';
import { getEntriesForTarget } from '../lib/share/registry';
import { getUserByEmail } from '../lib/user/user';

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
        async ({ body, cookie }) => {
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

            let existingUser = await getUserByEmail(email);
            let isNewUser = false;

            if (existingUser) {
                if (existingUser.role !== 'guest') {
                    throw new ApiError(400, 'Use password login');
                }
            } else {
                const localPart = email.split('@')[0] ?? email;
                const created = await auth.api.createUser({
                    body: {
                        email,
                        password: randomUUID(),
                        name: localPart,
                        role: 'guest',
                    },
                });
                existingUser = created.user;
                isNewUser = true;
            }

            if (isNewUser) {
                await reconcileSharesForNewUser(existingUser);
            }

            // Create session directly — we don't know the guest's random password
            const token = randomUUID();
            const now = new Date();
            const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

            db.insert(session)
                .values({
                    id: randomUUID(),
                    token,
                    userId: existingUser.id,
                    expiresAt,
                    createdAt: now,
                    updatedAt: now,
                })
                .run();

            cookie['better-auth.session_token'].set({
                value: token,
                httpOnly: true,
                secure: false,
                sameSite: 'lax',
                path: '/',
                expires: expiresAt,
            });

            return {
                success: true,
                user: {
                    id: existingUser.id,
                    email: existingUser.email,
                    name: existingUser.name,
                    role: existingUser.role,
                },
            };
        },
        { body: verifyBody },
    );
