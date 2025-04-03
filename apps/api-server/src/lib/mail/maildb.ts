import type Database from "bun:sqlite";
import {drizzle} from "drizzle-orm/bun-sqlite";
import {and, count, eq} from "drizzle-orm";
import * as schema from "./schema.ts";
import type {EmailSummary} from "./mailtypes.ts";
import {Home} from "../home/home.ts";

async function getMailDatabase(home: Home) {
    const db = await home.openSQLiteDatabase('eigen.mail/mail.db', async (db: Database) => {
        // Execute migration SQL to create tables
        db.exec(`
            CREATE TABLE IF NOT EXISTS emails (
                id TEXT PRIMARY KEY,
                subject TEXT NOT NULL,
                textShort TEXT NOT NULL,
                fromShort TEXT NOT NULL,
                size INTEGER NOT NULL DEFAULT 0,
                date INTEGER NOT NULL,
                isRead INTEGER NOT NULL DEFAULT 0,  
                isStarred INTEGER NOT NULL DEFAULT 0,
                isDraft INTEGER NOT NULL DEFAULT 0,
                hasAttachments INTEGER NOT NULL DEFAULT 0,
                mailbox TEXT NOT NULL,
                _isParsed INTEGER NOT NULL DEFAULT 0,
                createdAt INTEGER DEFAULT (unixepoch()),
                updatedAt INTEGER DEFAULT (unixepoch())
            );
            
            CREATE TABLE IF NOT EXISTS email_labels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                createdAt INTEGER DEFAULT (unixepoch()),
                updatedAt INTEGER DEFAULT (unixepoch())
            );
            
            CREATE TABLE IF NOT EXISTS emails_to_labels (
                emailId TEXT NOT NULL,
                labelId TEXT NOT NULL,
                PRIMARY KEY (emailId, labelId),
                FOREIGN KEY (emailId) REFERENCES emails(id) ON DELETE CASCADE,
                FOREIGN KEY (labelId) REFERENCES email_labels(id) ON DELETE CASCADE
            );
        `);
    });

    return drizzle(db, {schema});
}

export default class maildb {
    private home: Home;
    private db!: ReturnType<typeof drizzle<typeof schema>>;

    constructor(home: Home) {
        this.home = home;
    }

    public async init() {
        this.db = await getMailDatabase(this.home);
    }

    public async addEmail(email: EmailSummary) {
        const date = email.date instanceof Date
            ? email.date
            : (email.date ? new Date(email.date) : new Date());

        // Use type assertion to help TypeScript understand the types match the schema
        const emailRecord = {
            id: email.id,
            subject: email.subject?.toString() || '',
            fromShort: String(email.fromShort || ''),
            textShort: String(email.textShort || ''),
            date: date,
            size: email.size,
            isRead: Boolean(email.isRead),
            isStarred: Boolean(email.isStarred),
            isDraft: Boolean(email.isDraft),
            hasAttachments: Boolean(email.hasAttachments),
            mailbox: String(email.mailbox || '').toLowerCase(),
            _isParsed: Boolean(email._isParsed),
            createdAt: new Date(),
            updatedAt: new Date()
        } as const;

        // check if emailRecord already exists
        const existingEmail = this.db.select().from(schema.emails).where(eq(schema.emails.id, emailRecord.id)).get();
        if (existingEmail) {
            // Update the existing email record
            // remove id from emailRecord
            const {id, ...rest} = emailRecord;
            return this.db.update(schema.emails).set(rest).where(eq(schema.emails.id, email.id));
        } else {
            return this.db.insert(schema.emails).values(emailRecord);
        }
    }

    public async getEmailsCount(mailbox: string) {
        mailbox = mailbox.toLowerCase();
        return (await this.db.select({ count: count() }).from(schema.emails).where(eq(schema.emails.mailbox, mailbox)))[0].count;
    }

    public async getEmailsCountUnread(mailbox: string) {
        mailbox = mailbox.toLowerCase();
        return (await this.db.select({ count: count() }).from(schema.emails).where(
            and(
                eq(schema.emails.mailbox, mailbox),
                eq(schema.emails.isRead, false)
            )))[0].count;
    }

    public async getEmail(id: string) {
        return this.db.select().from(schema.emails).where(eq(schema.emails.id, id)).get();
    }

    public async deleteEmail(id: string) {
        return this.db.delete(schema.emails).where(eq(schema.emails.id, id));
    }

    public async moveEmail(id: string, mailbox: string) {
        mailbox = mailbox.toLowerCase();
        const isDraft = mailbox == 'drafts';
        return this.db.update(schema.emails).set({mailbox, isDraft}).where(eq(schema.emails.id, id));
    }

    public async renameMailbox(mailbox: string, newMailbox: string) {
        mailbox = mailbox.toLowerCase();
        newMailbox = newMailbox.toLowerCase();
        return this.db.update(schema.emails).set({mailbox: newMailbox}).where(eq(schema.emails.mailbox, mailbox));
    }

    public async deleteMailbox(mailbox: string) {
        mailbox = mailbox.toLowerCase();
        return this.db.delete(schema.emails).where(eq(schema.emails.mailbox, mailbox));
    }

    public async setRead(id: string, isRead: boolean) {
        return this.db.update(schema.emails).set({isRead}).where(eq(schema.emails.id, id));
    }

    public async setStarred(id: string, isStarred: boolean) {
        return this.db.update(schema.emails).set({isStarred}).where(eq(schema.emails.id, id));
    }

    public async setDraft(id: string, isDraft: boolean) {
        return this.db.update(schema.emails).set({isDraft}).where(eq(schema.emails.id, id));
    }

    public async getAllEmails(mailbox: string) {
        mailbox = mailbox.toLowerCase();
        return this.db.select().from(schema.emails).where(eq(schema.emails.mailbox, mailbox));
    }
}