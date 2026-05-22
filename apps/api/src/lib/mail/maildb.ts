import type { EmailSummary } from '@workspace/lib/types/mail';
import type { MailSearchHit } from '@workspace/lib/types/search';
import { and, count, eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { PATHS } from '../core';
import type { ManagedDatabase } from '../core/managed-database';
import type { Home } from '../home';
import { SEARCH_DB_CONFIG } from '../search/db-config';
import { type SearchDoc, SearchIndex } from '../search/search-index';
import { MAIL_DB_CONFIG } from './db-config';
import * as schema from './schema';

// The fields the search index needs from an email. Both the `record` built in addEmail and
// a row read back via getEmail() structurally satisfy this shape.
type IndexableEmail = {
    id: string;
    subject: string;
    fromShort: string;
    fromAddress: string;
    textShort: string;
    mailbox: string;
    date: Date;
};

// The mail-specific display fields carried in a search hit's `metadata`. emailToSearchDoc
// writes this shape; searchMail reads it back — one named type keeps the two seams in sync.
type MailSearchMetadata = { from: string; mailbox: string };

// Projection of an email into a generic search document. Sender and body are joined into
// the indexed `body` so both are searchable; `metadata` carries display-only fields.
function emailToSearchDoc(email: IndexableEmail): SearchDoc {
    const metadata: MailSearchMetadata = { from: email.fromShort, mailbox: email.mailbox };
    return {
        kind: 'mail',
        itemId: email.id,
        title: email.subject,
        body: `${email.fromShort}\n${email.fromAddress}\n${email.textShort}`,
        metadata,
        sortKey: email.date.getTime(),
    };
}

export default class MailDB {
    private home: Home;
    private managedDb!: ManagedDatabase<typeof schema>;
    private db!: BunSQLiteDatabase<typeof schema>;
    private searchIndex!: SearchIndex;

    constructor(home: Home) {
        this.home = home;
    }

    async init() {
        this.managedDb = await this.home.getLocalDatabase(MAIL_DB_CONFIG, PATHS.MAIL.DB);
        this.db = this.managedDb.db;
        const searchManaged = await this.home.getLocalDatabase(SEARCH_DB_CONFIG, PATHS.MAIL.SEARCH_DB);
        this.searchIndex = new SearchIndex(searchManaged.db);
        // Backfill only a fresh index — the write-hooks keep an existing one current, and the
        // search.db file persists across Home recreates, so this runs at most once.
        if (this.searchIndex.isEmpty()) {
            this.backfillSearchIndex().catch((err) => console.error('mail search backfill failed:', err));
        }
    }

    // Search-index writes are best-effort: the index is derived data, so a failure here must
    // never break mail delivery or any mail mutation.
    private safeIndex(action: () => void): void {
        try {
            action();
        } catch (error) {
            console.error('mail search index update failed:', error);
        }
    }

    private reindexEmail(id: string): void {
        const email = this.getEmail(id);
        if (email) this.safeIndex(() => this.searchIndex.upsert(emailToSearchDoc(email)));
    }

    addEmail(email: EmailSummary): boolean {
        const date = email.date instanceof Date ? email.date : email.date ? new Date(email.date) : new Date();

        const record = {
            id: email.id,
            filename: email.filename,
            subject: email.subject?.toString() || '',
            fromShort: String(email.fromShort || ''),
            fromAddress: String(email.fromAddress || ''),
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
        let inserted: boolean;
        if (existing) {
            const { id, ...rest } = record;
            this.db.update(schema.emails).set(rest).where(eq(schema.emails.id, email.id)).run();
            inserted = false;
        } else {
            this.db.insert(schema.emails).values(record).run();
            inserted = true;
        }
        this.safeIndex(() => this.searchIndex.upsert(emailToSearchDoc(record)));
        return inserted;
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
        this.safeIndex(() => this.searchIndex.delete('mail', id));
    }

    moveEmail(id: string, mailbox: string) {
        this.db.update(schema.emails).set({ mailbox }).where(eq(schema.emails.id, id)).run();
        this.reindexEmail(id);
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

    // `text` is the full draft body. emails.textShort stays a truncated preview for list
    // views, but the search index gets the complete body.
    updateDraftContent(id: string, subject: string, text: string): void {
        this.db
            .update(schema.emails)
            .set({ subject, textShort: text.slice(0, 200), updatedAt: new Date() })
            .where(eq(schema.emails.id, id))
            .run();
        const email = this.getEmail(id);
        if (email) this.safeIndex(() => this.searchIndex.upsert(emailToSearchDoc({ ...email, textShort: text })));
    }

    getAllEmails(mailbox: string) {
        return this.db.select().from(schema.emails).where(eq(schema.emails.mailbox, mailbox)).all();
    }

    searchMail(query: string, limit: number): MailSearchHit[] {
        return this.searchIndex.query(query, limit).map((hit) => {
            const meta = hit.metadata as MailSearchMetadata;
            return {
                kind: 'mail' as const,
                id: hit.itemId,
                subject: hit.title,
                from: meta.from,
                mailbox: meta.mailbox,
                date: new Date(hit.sortKey),
            };
        });
    }

    // Idempotent full re-index of every email into the search index. Per-email best-effort
    // so one bad row never aborts the rest.
    async backfillSearchIndex(): Promise<void> {
        const emails = this.db.select().from(schema.emails).all();
        for (const email of emails) {
            try {
                this.searchIndex.upsert(emailToSearchDoc(email));
            } catch (error) {
                console.error(`mail search backfill failed for ${email.id}:`, error);
            }
        }
    }

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }
}
