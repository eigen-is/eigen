import { randomUUID } from 'node:crypto';
import { escapeHtml } from '@workspace/lib/html';
import type { WaitlistEntry } from '@workspace/lib/types/waitlist';
import { validateEmailAddress, validateUsername } from '@workspace/lib/validation';
import { and, desc, eq } from 'drizzle-orm';
import { getServerDataPath } from '../config/paths';
import { getPublicConfig } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';
import { ApiError } from '../core/errors';
import { composeInviteEmail } from '../core/mail-composers';
import type { OutboundMail } from '../core/mailer';
import { ManagedDatabase } from '../core/managed-database';
import { WAITLIST_DB_CONFIG } from './db-config';
import * as schema from './schema';

const INVITE_EXPIRY_DAYS = 7;

let managedDb: ManagedDatabase<typeof schema> | null = null;

async function db() {
    if (!managedDb) {
        managedDb = new ManagedDatabase(WAITLIST_DB_CONFIG, getServerDataPath('waitlist.db'));
        await managedDb.open();
    }
    return managedDb.db;
}

export async function submitWaitlist(email: string, notes: string): Promise<boolean> {
    email = email.trim().toLowerCase();
    if (!validateEmailAddress(email)) throw new ApiError(400, 'Invalid email address');

    const d = await db();
    const existing = await d.select().from(schema.waitlist).where(eq(schema.waitlist.email, email)).get();

    if (existing) {
        if (existing.status === 'pending' || existing.status === 'rejected') {
            await d
                .update(schema.waitlist)
                .set({ notes, status: 'pending', updatedAt: new Date() })
                .where(eq(schema.waitlist.id, existing.id));
            return true;
        }
        if (existing.status === 'invited') throw new ApiError(409, 'You have already been invited');
        throw new ApiError(409, 'This email is already registered');
    }

    await d.insert(schema.waitlist).values({
        id: randomUUID(),
        email,
        notes,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
    });
    return true;
}

export async function listWaitlist(status?: string): Promise<WaitlistEntry[]> {
    const d = await db();
    if (status) {
        return d
            .select()
            .from(schema.waitlist)
            .where(eq(schema.waitlist.status, status))
            .orderBy(desc(schema.waitlist.createdAt))
            .all();
    }
    return d.select().from(schema.waitlist).orderBy(desc(schema.waitlist.createdAt)).all();
}

export async function getWaitlistEntry(id: string) {
    const d = await db();
    return d.select().from(schema.waitlist).where(eq(schema.waitlist.id, id)).get();
}

export async function acceptWaitlistEntry(id: string) {
    const entry = await getWaitlistEntry(id);
    if (!entry || (entry.status !== 'pending' && entry.status !== 'rejected')) return null;

    const d = await db();
    const inviteToken = randomUUID();
    const inviteExpiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    await d
        .update(schema.waitlist)
        .set({ status: 'invited', inviteToken, inviteExpiresAt, invitedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.waitlist.id, id));

    return { ...entry, status: 'invited' as const, inviteToken, inviteExpiresAt };
}

export async function rejectWaitlistEntry(id: string) {
    const entry = await getWaitlistEntry(id);
    if (!entry || entry.status === 'registered') return null;

    const d = await db();
    await d
        .update(schema.waitlist)
        .set({ status: 'rejected', inviteToken: null, inviteExpiresAt: null, updatedAt: new Date() })
        .where(eq(schema.waitlist.id, id));
    return true;
}

export async function resendWaitlistInvite(id: string) {
    const entry = await getWaitlistEntry(id);
    if (!entry || entry.status !== 'invited') return null;

    const d = await db();
    const inviteToken = randomUUID();
    const inviteExpiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    await d
        .update(schema.waitlist)
        .set({ inviteToken, inviteExpiresAt, invitedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.waitlist.id, id));

    return { ...entry, inviteToken, inviteExpiresAt };
}

export async function validateInviteToken(token: string) {
    const d = await db();
    const entry = await d.select().from(schema.waitlist).where(eq(schema.waitlist.inviteToken, token)).get();
    if (!entry) return null;
    if (entry.status !== 'invited') return null;
    if (entry.inviteExpiresAt && entry.inviteExpiresAt < new Date()) return null;
    return entry;
}

export async function claimInviteToken(token: string): Promise<boolean> {
    // Validate first, then atomically clear the token.
    // The UNIQUE constraint on inviteToken + setting it to null prevents races:
    // if two requests validate concurrently, only one finds a non-null token to clear.
    const entry = await validateInviteToken(token);
    if (!entry) return false;

    const d = await db();
    await d
        .update(schema.waitlist)
        .set({ status: 'registered', inviteToken: null, registeredAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.waitlist.id, entry.id), eq(schema.waitlist.inviteToken, token)));

    // Verify the update actually matched (token wasn't already claimed)
    const updated = await d.select().from(schema.waitlist).where(eq(schema.waitlist.id, entry.id)).get();
    return updated?.status === 'registered' && updated?.inviteToken === null;
}

export async function setRegisteredUser(email: string, userId: string) {
    const d = await db();
    await d.update(schema.waitlist).set({ userId }).where(eq(schema.waitlist.email, email));
}

export async function registerFromInvite(
    token: string,
    name: string,
    username: string,
    password: string,
): Promise<Response> {
    const entry = await validateInviteToken(token);
    if (!entry) throw new ApiError(400, 'Invalid or expired invite link');

    const usernameErr = validateUsername(username.toLowerCase());
    if (usernameErr) throw new ApiError(400, usernameErr);

    const config = getPublicConfig();
    const email = `${username.toLowerCase()}@${config?.mailDomain ?? 'localhost'}`;

    // Create user first — if it fails (e.g., username taken), the token stays valid
    const { auth } = await import('../auth/auth');
    let userId: string;
    try {
        const created = await auth.api.createUser({
            body: { name, email, password, role: 'user' },
        });
        if (!created?.user) throw new ApiError(400, 'Failed to create account');
        userId = created.user.id;
    } catch (err) {
        if (err instanceof ApiError) throw err;
        const msg = err instanceof Error ? err.message : 'Failed to create account';
        throw new ApiError(400, msg.includes('already') ? 'Username is already taken' : msg);
    }

    // Claim token atomically — if it fails, user exists but can log in normally
    const claimed = await claimInviteToken(token);
    if (!claimed) throw new ApiError(409, 'Invite has already been used');

    setRegisteredUser(entry.email, userId).catch(() => {});

    // Sign in and return response with session cookie
    return auth.api.signInEmail({ body: { email, password }, asResponse: true });
}

export async function removeWaitlistEntry(id: string) {
    const d = await db();
    await d.delete(schema.waitlist).where(eq(schema.waitlist.id, id));
}

export function requireWaitlistEnabled() {
    const settings = getServerSettings();
    if (!settings.onboarding.waitlist.enabled) {
        throw new ApiError(403, 'Waitlist is not enabled');
    }
}

export function buildInviteEmail(entry: { email: string; inviteToken: string | null }): OutboundMail {
    const settings = getServerSettings();
    const config = getPublicConfig();
    const template = settings.onboarding.inviteEmail;
    const orgName = config?.orgName ?? 'Eigen';
    const domain = config?.domain ?? 'localhost';
    const inviteLink = `https://${domain}/space/signup?token=${entry.inviteToken}`;

    // Body template is HTML — escape token values so the recipient email or an admin-set
    // orgName containing `<` / `&` can't break out of the wrapper. Subject is plain text;
    // no escaping there. inviteToken is a UUID so the link is always URL-safe; we still
    // HTML-escape it because it's interpolated into an `href` attribute value.
    const subjectTokens = { email: entry.email, orgName, domain, inviteLink };
    const bodyTokens = {
        email: escapeHtml(entry.email),
        orgName: escapeHtml(orgName),
        domain: escapeHtml(domain),
        inviteLink: escapeHtml(inviteLink),
    };

    return composeInviteEmail({
        recipient: { email: entry.email },
        subject: applyTokens(template.subject, subjectTokens),
        bodyHtml: applyTokens(template.body, bodyTokens),
        orgName,
    });
}

function applyTokens(template: string, values: Record<string, string>): string {
    let out = template;
    for (const [key, val] of Object.entries(values)) {
        out = out.replaceAll(`{${key}}`, val);
    }
    return out;
}
