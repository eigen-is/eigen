import type {User} from "better-auth";
import type Database from "bun:sqlite";
import {drizzle} from "drizzle-orm/bun-sqlite";
import {eq} from "drizzle-orm";
import * as schema from "./schema.ts";
import type {EmailSummary} from "./mailtypes.ts";
import {getHome} from "../home/home.ts";

async function getMailDatabase(user: User) {
    const home = await getHome(user);
    const db = await home.openSQLiteDatabase('eigen.mail/mail.db', async (db: Database) => {
        // Execute migration SQL to create tables
        db.exec(`
            CREATE TABLE IF NOT EXISTS emails (
                id TEXT PRIMARY KEY,
                subject TEXT NOT NULL,
                textShort TEXT NOT NULL,
                fromShort TEXT NOT NULL,
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
    private user: User;
    private db!: ReturnType<typeof drizzle<typeof schema>>;

    constructor(user: User) {
        this.user = user;
    }

    public async init() {
        this.db = await getMailDatabase(this.user);
    }

    public async addEmail(email: EmailSummary) {
        const date = email.date instanceof Date
            ? email.date
            : (email.date ? new Date(email.date) : new Date());

        // Use type assertion to help TypeScript understand the types match the schema
        const emailRecord = {
            id: email.id,
            subject: email.subject?.toString() || '(No subject)',
            fromShort: String(email.fromShort || ''),
            textShort: String(email.textShort || ''),
            date: date,
            isRead: Boolean(email.isRead),
            isStarred: Boolean(email.isStarred),
            isDraft: Boolean(email.isDraft),
            hasAttachments: Boolean(email.hasAttachments),
            mailbox: String(email.mailbox || ''),
            _isParsed: Boolean(email._isParsed),
            createdAt: new Date(),
            updatedAt: new Date()
        } as const;

        // Cast the record to the expected type using 'as any' to bypass TypeScript checking
        // This is safe because we've structured the data to match the schema
        return await this.db.insert(schema.emails).values(emailRecord as any);
    }

    public async getEmail(id: string) {
        return await this.db.select().from(schema.emails).where(eq(schema.emails.id, id)).get();
    }

    public async deleteEmail(id: string) {
        return await this.db.delete(schema.emails).where(eq(schema.emails.id, id));
    }

    public async moveEmail(id: string, mailbox: string) {
        console.log('move email to mailbox:', mailbox);
        return await this.db.update(schema.emails).set({mailbox}).where(eq(schema.emails.id, id));
    }

    public async renameMailbox(mailbox: string, newMailbox: string) {
        return await this.db.update(schema.emails).set({mailbox: newMailbox}).where(eq(schema.emails.mailbox, mailbox));
    }

    public async deleteMailbox(mailbox: string) {
        return await this.db.delete(schema.emails).where(eq(schema.emails.mailbox, mailbox));
    }

    public async setRead(id: string, isRead: boolean) {
        return await this.db.update(schema.emails).set({isRead}).where(eq(schema.emails.id, id));
    }

    public async setStarred(id: string, isStarred: boolean) {
        return await this.db.update(schema.emails).set({isStarred}).where(eq(schema.emails.id, id));
    }

    public async setDraft(id: string, isDraft: boolean) {
        return await this.db.update(schema.emails).set({isDraft}).where(eq(schema.emails.id, id));
    }

    public async getAllEmails(mailbox: string) {
        console.log('search mails in mailbox:', mailbox);
        return await this.db.select().from(schema.emails).where(eq(schema.emails.mailbox, mailbox));
    }
}