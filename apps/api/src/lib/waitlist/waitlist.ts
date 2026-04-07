import { randomUUID } from 'node:crypto';
import { validateEmailAddress } from '@workspace/lib/validation';
import { eq } from 'drizzle-orm';
import { getServerDataPath } from '../config/paths';
import { getServerSettings } from '../config/server-settings';
import { sendMail } from '../core/mailer';
import { ManagedDatabase } from '../core/managed-database';
import { WAITLIST_DB_CONFIG } from './db-config';
import * as schema from './schema';

const INVITE_EXPIRY_DAYS = 7;

function sanitizeHtml(text: string) {
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class WaitlistService {
    private managedDb: ManagedDatabase<typeof schema> | null = null;

    private async db() {
        if (!this.managedDb) {
            this.managedDb = new ManagedDatabase(WAITLIST_DB_CONFIG, getServerDataPath('waitlist.db'));
            await this.managedDb.open();
        }
        return this.managedDb.db;
    }

    async submit(email: string, notes: string): Promise<boolean> {
        email = email.trim().toLowerCase();
        if (!validateEmailAddress(email)) return false;

        notes = sanitizeHtml(notes);
        const db = await this.db();

        const existing = await db.select().from(schema.waitlist).where(eq(schema.waitlist.email, email)).get();

        if (existing) {
            if (existing.status === 'pending' || existing.status === 'rejected') {
                await db
                    .update(schema.waitlist)
                    .set({ notes, status: 'pending', updatedAt: new Date() })
                    .where(eq(schema.waitlist.id, existing.id));
                this.sendNotificationEmail(email, notes);
                return true;
            }
            return false;
        }

        await db.insert(schema.waitlist).values({
            id: randomUUID(),
            email,
            notes,
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        this.sendNotificationEmail(email, notes);
        return true;
    }

    private sendNotificationEmail(email: string, notes: string) {
        const settings = getServerSettings();
        const notifyEmail = settings.onboarding.waitlist.notifyEmail;
        if (!notifyEmail) return;

        const time = new Date().toISOString();
        sendMail({
            to: [{ name: '', address: notifyEmail }],
            subject: 'New Eigen Waitlist Signup',
            text: `New waitlist signup:\n\nEmail: <${email}>\nNotes: ${notes}\n\nTime: ${time}`,
            html: `<h2>New Waitlist Signup</h2><p><strong>Email:</strong> ${email}</p><p><strong>Notes:</strong> ${notes}</p><p><strong>Time:</strong> ${time}</p>`,
        }).catch(() => {});
    }

    async list(status?: string) {
        const db = await this.db();
        if (status) {
            return db.select().from(schema.waitlist).where(eq(schema.waitlist.status, status)).all();
        }
        return db.select().from(schema.waitlist).all();
    }

    async get(id: string) {
        const db = await this.db();
        return db.select().from(schema.waitlist).where(eq(schema.waitlist.id, id)).get();
    }

    async accept(id: string) {
        const entry = await this.get(id);
        if (!entry || (entry.status !== 'pending' && entry.status !== 'rejected')) return null;

        const db = await this.db();
        const inviteToken = randomUUID();
        const inviteExpiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

        await db
            .update(schema.waitlist)
            .set({ status: 'invited', inviteToken, inviteExpiresAt, invitedAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.waitlist.id, id));

        return { ...entry, status: 'invited' as const, inviteToken, inviteExpiresAt };
    }

    async reject(id: string) {
        const entry = await this.get(id);
        if (!entry || entry.status === 'registered') return null;

        const db = await this.db();
        await db
            .update(schema.waitlist)
            .set({ status: 'rejected', inviteToken: null, inviteExpiresAt: null, updatedAt: new Date() })
            .where(eq(schema.waitlist.id, id));
        return true;
    }

    async resendInvite(id: string) {
        const entry = await this.get(id);
        if (!entry || entry.status !== 'invited') return null;

        const db = await this.db();
        const inviteToken = randomUUID();
        const inviteExpiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

        await db
            .update(schema.waitlist)
            .set({ inviteToken, inviteExpiresAt, invitedAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.waitlist.id, id));

        return { ...entry, inviteToken, inviteExpiresAt };
    }

    async validateToken(token: string) {
        const db = await this.db();
        const entry = await db.select().from(schema.waitlist).where(eq(schema.waitlist.inviteToken, token)).get();
        if (!entry) return null;
        if (entry.status !== 'invited') return null;
        if (entry.inviteExpiresAt && entry.inviteExpiresAt < new Date()) return null;
        return entry;
    }

    async claimToken(token: string, userId: string): Promise<boolean> {
        // Atomic: only succeeds if token is still valid and status is 'invited'
        const entry = await this.validateToken(token);
        if (!entry) return false;

        const db = await this.db();
        await db
            .update(schema.waitlist)
            .set({ status: 'registered', userId, inviteToken: null, registeredAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.waitlist.id, entry.id));
        return true;
    }

    async remove(id: string) {
        const db = await this.db();
        await db.delete(schema.waitlist).where(eq(schema.waitlist.id, id));
    }

    async close() {
        await this.managedDb?.close();
    }
}

export const waitlistService = new WaitlistService();
