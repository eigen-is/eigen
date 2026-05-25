import type { EmailSummary } from '@workspace/lib/types/mail';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { PATHS } from '../core';
import type { ManagedDatabase } from '../core/managed-database';
import type { Home } from '../home';
import { MAIL_DB_CONFIG } from './db-config';
import * as schema from './schema';

// Mailboxes excluded from default mail search — users can still search them explicitly.
const SEARCH_EXCLUDED_MAILBOXES = ['Trash', 'Junk'];

// FTS5's query grammar treats " * ( ) : ^ - and similar punctuation as operators, so raw
// user input cannot be passed through. Replace every non-letter/digit run with a space,
// phrase-quote each token and append a prefix wildcard: 'q3 budget!' -> '"q3"* "budget"*'.
function sanitizeFtsQuery(text: string): string {
    return text
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(' ')
        .filter((token) => token.length > 0)
        .map((token) => `"${token}"*`)
        .join(' ');
}

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

    // `text` is the full draft body, but emails.textShort stores a truncated preview for
    // list views — the same shape as received mail. The FTS5 trigger on emails picks up
    // whatever lands in textShort, so drafts get indexed at preview granularity.
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
    }

    getAllEmails(mailbox: string) {
        return this.db.select().from(schema.emails).where(eq(schema.emails.mailbox, mailbox)).all();
    }

    searchMail(opts: { q: string; limit: number; mailboxes?: string[]; from?: string; to?: string }): EmailSummary[] {
        const match = sanitizeFtsQuery(opts.q);
        if (!match) return [];

        // Filter-first: when a structured filter is present, narrow to candidate ids via
        // mail.db's own indexed columns, then ask the FTS index to rank within that
        // subset. Exact recall at any selectivity; no candidate-pool over-fetch.
        let candidateIds: string[] | undefined;
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
            candidateIds = rows.map((r) => r.id);
            if (candidateIds.length === 0) return [];
        }

        let mailboxFilter = sql``;
        if (opts.mailboxes && opts.mailboxes.length > 0) {
            const list = sql.join(
                opts.mailboxes.map((m) => sql`${m}`),
                sql`, `,
            );
            mailboxFilter = sql` AND e.mailbox IN (${list})`;
        } else {
            const list = sql.join(
                SEARCH_EXCLUDED_MAILBOXES.map((m) => sql`${m}`),
                sql`, `,
            );
            mailboxFilter = sql` AND e.mailbox NOT IN (${list})`;
        }

        let candidateFilter = sql``;
        if (candidateIds) {
            const list = sql.join(
                candidateIds.map((id) => sql`${id}`),
                sql`, `,
            );
            candidateFilter = sql` AND e.id IN (${list})`;
        }

        // Pass 1: rank via FTS5, return ordered ids only. No Drizzle column-mode conversion
        // applies to raw `sql``` results, so we deliberately stay in id-space here.
        const ranked = this.db.all(sql`
            SELECT e.id AS id
            FROM emails_fts
            JOIN emails e ON e.rowid = emails_fts.rowid
            WHERE emails_fts MATCH ${match}${mailboxFilter}${candidateFilter}
            ORDER BY bm25(emails_fts), e.date DESC, e.id DESC
            LIMIT ${opts.limit}
        `) as { id: string }[];
        if (ranked.length === 0) return [];

        // Pass 2: re-fetch the ranked rows through Drizzle so `date` / `createdAt` /
        // `updatedAt` come back as Date (mode: 'timestamp' applies). Order preserved via
        // the id-keyed map.
        const ids = ranked.map((r) => r.id);
        const rows = this.db.select().from(schema.emails).where(inArray(schema.emails.id, ids)).all();
        const byId = new Map(rows.map((r) => [r.id, r]));
        return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined);
    }

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }
}
