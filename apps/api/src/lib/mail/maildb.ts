import type { EmailSummary } from '@workspace/lib/types/mail';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { PATHS } from '../core';
import type { ManagedDatabase } from '../core/managed-database';
import type { Home } from '../home';
import { SEARCH_DB_CONFIG } from '../search/db-config';
import { type SearchDoc, SearchIndex } from '../search/search-index';
import { MAIL_DB_CONFIG } from './db-config';
import * as schema from './schema';

// Mailboxes excluded from default mail search — users can still search them explicitly.
const SEARCH_EXCLUDED_MAILBOXES = ['Trash', 'Junk'];

// Projection of an email into a generic search document. Sender, recipient and body are
// joined into the indexed `body` so all three are searchable. `bucket` holds the mailbox so
// the search index can filter by it without knowing mail concepts.
function emailToSearchDoc(email: EmailSummary): SearchDoc {
    return {
        kind: 'mail',
        itemId: email.id,
        bucket: email.mailbox,
        title: email.subject,
        body: `${email.fromShort}\n${email.fromAddress}\n${email.toShort}\n${email.toAddress}\n${email.recipientsAll}\n${email.textShort}`,
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
            toShort: String(email.toShort || ''),
            toAddress: String(email.toAddress || ''),
            recipientsAll: String(email.recipientsAll || ''),
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
    updateDraftContent(
        id: string,
        subject: string,
        text: string,
        recipients?: { toShort: string; toAddress: string; recipientsAll: string },
    ): void {
        this.db
            .update(schema.emails)
            .set({
                subject,
                textShort: text.slice(0, 200),
                updatedAt: new Date(),
                ...(recipients && {
                    toShort: recipients.toShort,
                    toAddress: recipients.toAddress,
                    recipientsAll: recipients.recipientsAll,
                }),
            })
            .where(eq(schema.emails.id, id))
            .run();
        const email = this.getEmail(id);
        if (email) this.safeIndex(() => this.searchIndex.upsert(emailToSearchDoc({ ...email, textShort: text })));
    }

    getAllEmails(mailbox: string) {
        return this.db.select().from(schema.emails).where(eq(schema.emails.mailbox, mailbox)).all();
    }

    searchMail(opts: { q: string; limit: number; mailboxes?: string[]; from?: string; to?: string }): EmailSummary[] {
        // Filter-first: when a structured filter is present, narrow to candidate ids via
        // mail.db's own indexed columns, then ask the search index to rank within that
        // subset. Exact recall at any selectivity; no candidate-pool over-fetch.
        let itemIds: string[] | undefined;
        if (opts.from || opts.to) {
            const conditions = [];
            if (opts.from) {
                const needle = `%${opts.from.toLowerCase()}%`;
                conditions.push(
                    sql`(lower(${schema.emails.fromShort}) LIKE ${needle} OR lower(${schema.emails.fromAddress}) LIKE ${needle})`,
                );
            }
            if (opts.to) {
                const needle = `%${opts.to.toLowerCase()}%`;
                conditions.push(sql`lower(${schema.emails.recipientsAll}) LIKE ${needle}`);
            }
            const rows = this.db
                .select({ id: schema.emails.id })
                .from(schema.emails)
                .where(and(...conditions))
                .all();
            itemIds = rows.map((r) => r.id);
            if (itemIds.length === 0) return [];
        }

        const indexOpts: { buckets?: string[]; excludeBuckets?: string[]; itemIds?: string[] } = {};
        if (itemIds) indexOpts.itemIds = itemIds;
        if (opts.mailboxes && opts.mailboxes.length > 0) {
            indexOpts.buckets = opts.mailboxes;
        } else {
            // Default mailbox exclusion applies whether or not a structured filter is active —
            // the user has not opted into searching Trash/Spam unless they pass `mailboxes`
            // explicitly.
            indexOpts.excludeBuckets = SEARCH_EXCLUDED_MAILBOXES;
        }

        const ids = this.searchIndex.query(opts.q, opts.limit, indexOpts);
        if (ids.length === 0) return [];
        const rows = this.db.select().from(schema.emails).where(inArray(schema.emails.id, ids)).all();
        const byId = new Map(rows.map((r) => [r.id, r]));
        return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined);
    }

    // Idempotent full re-index of every email. Runs in transactional batches and yields the
    // event loop between them (Bun.sleep(0)), so even a large mailbox never blocks concurrent
    // requests for longer than a single batch.
    async backfillSearchIndex(): Promise<void> {
        const BATCH_SIZE = 250;
        const emails = this.db.select().from(schema.emails).all();
        for (let i = 0; i < emails.length; i += BATCH_SIZE) {
            const batch = emails.slice(i, i + BATCH_SIZE);
            try {
                this.searchIndex.upsertBatch(batch.map(emailToSearchDoc));
            } catch (error) {
                console.error(`mail search backfill failed for batch at offset ${i}:`, error);
            }
            await Bun.sleep(0);
        }
    }

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }
}
