import type { EmailSummary } from '@workspace/lib/types/mail';
import { and, count, eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { PATHS } from '../core';
import type { ManagedDatabase } from '../core/managed-database';
import type { Home } from '../home';
import { MAIL_DB_CONFIG } from './db-config';
import * as schema from './schema';

export default class MailDB {
    private home: Home;
    private managedDb!: ManagedDatabase<typeof schema>;
    private db!: BunSQLiteDatabase<typeof schema>;

    constructor(home: Home) {
        this.home = home;
    }

    async init() {
        this.managedDb = await this.home.getLocalDatabase(MAIL_DB_CONFIG, PATHS.MAIL.DB);
        this.db = this.managedDb.db;
    }

    addEmail(email: EmailSummary) {
        const date = email.date instanceof Date ? email.date : email.date ? new Date(email.date) : new Date();

        const record = {
            id: email.id,
            filename: email.filename,
            subject: email.subject?.toString() || '',
            fromShort: String(email.fromShort || ''),
            textShort: String(email.textShort || ''),
            date,
            size: email.size,
            isRead: Boolean(email.isRead),
            isFlagged: Boolean(email.isFlagged),
            isDraft: Boolean(email.isDraft),
            isReplied: Boolean(email.isReplied),
            hasAttachments: Boolean(email.hasAttachments),
            mailbox: String(email.mailbox || ''),
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const existing = this.db.select().from(schema.emails).where(eq(schema.emails.id, record.id)).get();
        if (existing) {
            const { id, ...rest } = record;
            this.db.update(schema.emails).set(rest).where(eq(schema.emails.id, email.id)).run();
        } else {
            this.db.insert(schema.emails).values(record).run();
        }
    }

    size() {
        return (this.db.select({ size: sql`SUM(size)` }).from(schema.emails).get()?.size as number) || 0;
    }

    getEmailsCount(mailbox: string) {
        return this.db.select({ count: count() }).from(schema.emails).where(eq(schema.emails.mailbox, mailbox)).get()!
            .count;
    }

    getEmailsCountUnread(mailbox: string) {
        return this.db
            .select({ count: count() })
            .from(schema.emails)
            .where(and(eq(schema.emails.mailbox, mailbox), eq(schema.emails.isRead, false)))
            .get()!.count;
    }

    getEmail(id: string) {
        return this.db.select().from(schema.emails).where(eq(schema.emails.id, id)).get();
    }

    deleteEmail(id: string) {
        this.db.delete(schema.emails).where(eq(schema.emails.id, id)).run();
    }

    moveEmail(id: string, mailbox: string) {
        this.db.update(schema.emails).set({ mailbox }).where(eq(schema.emails.id, id)).run();
    }

    setRead(id: string, isRead: boolean) {
        this.db.update(schema.emails).set({ isRead }).where(eq(schema.emails.id, id)).run();
    }

    setFlagged(id: string, isFlagged: boolean) {
        this.db.update(schema.emails).set({ isFlagged }).where(eq(schema.emails.id, id)).run();
    }

    setDraft(id: string, isDraft: boolean) {
        this.db.update(schema.emails).set({ isDraft }).where(eq(schema.emails.id, id)).run();
    }

    setFilename(id: string, filename: string) {
        this.db.update(schema.emails).set({ filename }).where(eq(schema.emails.id, id)).run();
    }

    updateFlags(
        id: string,
        flags: { isRead: boolean; isFlagged: boolean; isDraft: boolean; isReplied: boolean },
        filename: string,
    ) {
        this.db
            .update(schema.emails)
            .set({ ...flags, filename })
            .where(eq(schema.emails.id, id))
            .run();
    }

    getAllEmails(mailbox: string) {
        return this.db.select().from(schema.emails).where(eq(schema.emails.mailbox, mailbox)).all();
    }

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }
}
