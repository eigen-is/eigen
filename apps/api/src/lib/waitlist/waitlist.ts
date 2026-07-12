import { randomUUID } from 'node:crypto';
import { escapeHtml } from '@workspace/lib/html';
import type { WaitlistEntry } from '@workspace/lib/types/waitlist';
import { validateEmailAddress, validateUsername } from '@workspace/lib/validation';
import { and, desc, eq } from 'drizzle-orm';
import { createAsyncSingleton } from '../../utils/singleton';
import { getServerDataPath } from '../config/paths';
import { getDomain, getOrgName, getPublicConfig } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';
import { ApiError } from '../core/errors';
import { composeInviteEmail } from '../core/mail-composers';
import type { OutboundMail } from '../core/mailer';
import { ManagedDatabase } from '../core/managed-database';
import { WAITLIST_DB_CONFIG } from './db-config';
import * as schema from './schema';

const INVITE_EXPIRY_DAYS = 7;

// Memoize the init PROMISE (not the resolved db) so concurrent first-callers await the same
// open() instead of one reading `.db` before open() resolves ("Database not open").
const getManagedDb = createAsyncSingleton(async () => {
    const managed = new ManagedDatabase(WAITLIST_DB_CONFIG, getServerDataPath('waitlist.db'));
    await managed.open();
    return managed;
});

async function db() {
    return (await getManagedDb()).db;
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
    const entry = await validateInviteToken(token);
    if (!entry) return false;

    const d = await db();
    // The token-guarded UPDATE is the atomic claim: whether THIS caller cleared the token is how
    // many rows it matched, not the row's post-state. Under a concurrent race both callers validate
    // the still-open row, but only the one whose WHERE matched the non-null token gets a RETURNING
    // row back; the loser matches 0 rows. Re-selecting the row would show `registered/null` to both.
    const claimed = d
        .update(schema.waitlist)
        .set({ status: 'registered', inviteToken: null, registeredAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.waitlist.id, entry.id), eq(schema.waitlist.inviteToken, token)))
        .returning({ id: schema.waitlist.id })
        .all();

    return claimed.length === 1;
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
    const email = `${username.toLowerCase()}@${config.mailDomain}`;

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
    const template = getServerSettings().onboarding.inviteEmail;
    const orgName = getOrgName();
    const domain = getDomain();
    const inviteLink = `https://${domain}/space/signup?token=${entry.inviteToken}`;

    const subject = template.subject
        .replaceAll('{email}', entry.email)
        .replaceAll('{orgName}', orgName)
        .replaceAll('{domain}', domain)
        .replaceAll('{inviteLink}', inviteLink);

    // Body template is HTML — escape token values so the recipient email or an admin-set
    // orgName containing `<` / `&` can't break out of the wrapper. inviteToken is a UUID so
    // the link is always URL-safe, but we still HTML-escape it because it's interpolated
    // into an `href` attribute value.
    const bodyHtml = template.body
        .replaceAll('{email}', escapeHtml(entry.email))
        .replaceAll('{orgName}', escapeHtml(orgName))
        .replaceAll('{domain}', escapeHtml(domain))
        .replaceAll('{inviteLink}', escapeHtml(inviteLink));

    return composeInviteEmail(entry.email, subject, bodyHtml, orgName);
}
