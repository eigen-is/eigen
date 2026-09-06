import { MAIL_PREVIEW_CHARS } from '@workspace/lib/constants/mail';
import type { EmailSummary, RecipientSummary } from '@workspace/lib/types/mail';
import { and, count, desc, eq, inArray, lt, or, type SQL, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { PATHS, sanitizeFtsQuery } from '../core';
import type { ManagedDatabase } from '../core/managed-database';
import type { Home } from '../home';
import { MAIL_DB_CONFIG } from './db-config';
import type { MailSearchOptions } from './mail-store';
import * as schema from './schema';

// Mailboxes excluded from default mail search — users can still search them explicitly.
const SEARCH_EXCLUDED_MAILBOXES = ['Trash', 'Junk'];

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

    // Picks the summary fields by name: callers hand in a full parsed Email, whose extra
    // ParsedMail fields have no column here.
    private toRecord(email: EmailSummary) {
        const now = new Date();
        return {
            id: email.id,
            filename: email.filename,
            subject: email.subject,
            fromShort: email.fromShort,
            fromAddress: email.fromAddress,
            toShort: email.toShort,
            toAddress: email.toAddress,
            recipientsAll: email.recipientsAll,
            textShort: email.textShort,
            date: email.date,
            size: email.size,
            isRead: email.isRead,
            isFlagged: email.isFlagged,
            isDraft: email.isDraft,
            isReplied: email.isReplied,
            hasAttachments: email.hasAttachments,
            mailbox: email.mailbox,
            createdAt: now,
            updatedAt: now,
        };
    }

    addEmail(email: EmailSummary): boolean {
        const record = this.toRecord(email);

        const existing = this.db.select().from(schema.emails).where(eq(schema.emails.id, record.id)).get();
        let inserted: boolean;
        if (existing) {
            const { id: _id, ...rest } = record;
            this.db.update(schema.emails).set(rest).where(eq(schema.emails.id, email.id)).run();
            inserted = false;
        } else {
            this.db.insert(schema.emails).values(record).run();
            inserted = true;
        }
        return inserted;
    }

    // Bulk insert-only path for the sync's cold-index loop: the caller's diff map already proved
    // every id is new, so this skips addEmail's per-row SELECT and commits the whole chunk in one
    // transaction. Upsert (not a plain insert) on the id PK: a cross-mailbox id collision (e.g. a
    // file whose message-id already lives in another mailbox's row, from a crash mid-move) would
    // make a plain insert throw and roll back the entire chunk — and the next sync would retry the
    // same chunk and roll back again, permanently stuck. Upsert re-homes the row instead, matching
    // addEmail's own check-then-update semantics, while staying a single statement per row.
    insertEmails(emails: EmailSummary[]): void {
        if (emails.length === 0) return;
        this.db.transaction((tx) => {
            for (const email of emails) {
                const record = this.toRecord(email);
                const { id: _id, ...rest } = record;
                tx.insert(schema.emails)
                    .values(record)
                    .onConflictDoUpdate({ target: schema.emails.id, set: rest })
                    .run();
            }
        });
    }

    size() {
        return this.db.select({ size: sql<number>`SUM(size)` }).from(schema.emails).get()?.size || 0;
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
    updateDraftContent(id: string, subject: string, text: string, recipients?: RecipientSummary): void {
        this.db
            .update(schema.emails)
            .set({
                subject,
                textShort: text.slice(0, MAIL_PREVIEW_CHARS),
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

    // Keyset pagination, newest-first. Composite (date, id) cursor because `date` has duplicate
    // values in practice; `id` (TEXT PK) is the tiebreak. Drizzle serializes the Date param to the
    // column's second unit, matching the stored value.
    listMessages(mailbox: string, opts: { limit: number; before?: { date: Date; id: string } }): EmailSummary[] {
        const conditions: (SQL | undefined)[] = [eq(schema.emails.mailbox, mailbox)];
        if (opts.before) {
            conditions.push(
                or(
                    lt(schema.emails.date, opts.before.date),
                    and(eq(schema.emails.date, opts.before.date), lt(schema.emails.id, opts.before.id)),
                ),
            );
        }
        const rows = this.db
            .select()
            .from(schema.emails)
            .where(and(...conditions))
            .orderBy(desc(schema.emails.date), desc(schema.emails.id))
            .limit(opts.limit)
            .all();
        // Cap the list-view preview at the response seam — the FULL textShort stays in the DB for FTS5.
        return rows.map((r) =>
            r.textShort.length > MAIL_PREVIEW_CHARS ? { ...r, textShort: r.textShort.slice(0, MAIL_PREVIEW_CHARS) } : r,
        );
    }

    searchMail(opts: MailSearchOptions): EmailSummary[] {
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
        const ranked = this.db.all<{ id: string }>(sql`
            SELECT e.id AS id
            FROM emails_fts
            JOIN emails e ON e.rowid = emails_fts.rowid
            WHERE emails_fts MATCH ${match}${mailboxFilter}${candidateFilter}
            ORDER BY bm25(emails_fts), e.date DESC, e.id DESC
            LIMIT ${opts.limit}
        `);
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
