import { randomUUID } from 'node:crypto';
import { validateEmailAddress } from '@workspace/lib/validation';
import { eq } from 'drizzle-orm';
import { getServerDataPath } from '../config/paths';
import { ManagedDatabase } from '../core/managed-database';
import { WAITLIST_DB_CONFIG } from './db-config';
import * as schema from './schema';

const INVITE_EXPIRY_DAYS = 7;

class WaitlistService {
    private managedDb: ManagedDatabase<typeof schema> | null = null;

    async open() {
        this.managedDb = new ManagedDatabase(WAITLIST_DB_CONFIG, getServerDataPath('waitlist.db'));
        await this.managedDb.open();
    }

    private get db() {
        if (!this.managedDb) throw new Error('Waitlist database not open');
        return this.managedDb.db;
    }

    async submit(email: string, notes: string): Promise<boolean> {
        email = email.trim().toLowerCase();
        if (!validateEmailAddress(email)) return false;

        notes = notes.replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const existing = await this.db.select().from(schema.waitlist).where(eq(schema.waitlist.email, email)).get();

        if (existing) {
            if (existing.status === 'pending' || existing.status === 'rejected') {
                await this.db
                    .update(schema.waitlist)
                    .set({ notes, status: 'pending', updatedAt: new Date() })
                    .where(eq(schema.waitlist.id, existing.id));
                return true;
            }
            return false;
        }

        await this.db.insert(schema.waitlist).values({
            id: randomUUID(),
            email,
            notes,
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        return true;
    }

    async list(status?: string) {
        if (status) {
            return this.db.select().from(schema.waitlist).where(eq(schema.waitlist.status, status)).all();
        }
        return this.db.select().from(schema.waitlist).all();
    }

    async get(id: string) {
        return this.db.select().from(schema.waitlist).where(eq(schema.waitlist.id, id)).get();
    }

    async accept(id: string) {
        const entry = await this.get(id);
        if (!entry || (entry.status !== 'pending' && entry.status !== 'rejected')) return null;

        const inviteToken = randomUUID();
        const inviteExpiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

        await this.db
            .update(schema.waitlist)
            .set({
                status: 'invited',
                inviteToken,
                inviteExpiresAt,
                invitedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(eq(schema.waitlist.id, id));

        return { ...entry, status: 'invited' as const, inviteToken, inviteExpiresAt };
    }

    async reject(id: string) {
        const entry = await this.get(id);
        if (!entry || entry.status === 'registered') return null;

        await this.db
            .update(schema.waitlist)
            .set({ status: 'rejected', inviteToken: null, inviteExpiresAt: null, updatedAt: new Date() })
            .where(eq(schema.waitlist.id, id));
        return true;
    }

    async resendInvite(id: string) {
        const entry = await this.get(id);
        if (!entry || entry.status !== 'invited') return null;

        const inviteToken = randomUUID();
        const inviteExpiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

        await this.db
            .update(schema.waitlist)
            .set({ inviteToken, inviteExpiresAt, invitedAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.waitlist.id, id));

        return { ...entry, inviteToken, inviteExpiresAt };
    }

    async validateToken(token: string) {
        const entry = await this.db.select().from(schema.waitlist).where(eq(schema.waitlist.inviteToken, token)).get();
        if (!entry) return null;
        if (entry.status !== 'invited') return null;
        if (entry.inviteExpiresAt && entry.inviteExpiresAt < new Date()) return null;
        return entry;
    }

    async getByToken(token: string) {
        return this.db.select().from(schema.waitlist).where(eq(schema.waitlist.inviteToken, token)).get();
    }

    async markRegistered(token: string, userId: string) {
        await this.db
            .update(schema.waitlist)
            .set({
                status: 'registered',
                userId,
                inviteToken: null,
                registeredAt: new Date(),
                updatedAt: new Date(),
            })
            .where(eq(schema.waitlist.inviteToken, token));
    }

    async remove(id: string) {
        await this.db.delete(schema.waitlist).where(eq(schema.waitlist.id, id));
    }

    async close() {
        await this.managedDb?.close();
    }
}

export const waitlistService = new WaitlistService();
