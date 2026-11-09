// The mail index of a user's Home: one SQLite database with a row for each message, and full-text search over it.
// The message itself stays in the maildir. The index keeps what lists and search need, such as the sender, the
// subject, the flags and the text. The Maildir store uses it for everything it reads and writes there.

import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { MAIL_PREVIEW_CHARS } from '@workspace/lib/constants/mail';
import { MAILBOX_JUNK, MAILBOX_TRASH } from '@workspace/lib/constants/mailboxes';
import type { EmailSummary } from '@workspace/lib/types/mail';
import type { SQL } from 'drizzle-orm';
import { and, count, desc, eq, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { PATHS } from '../config/paths';
import { sanitizeFtsQuery } from '../core';
import type { ManagedDatabase } from '../core/managed-database';
import type { Home } from '../home';
import { MAIL_DB_CONFIG } from './db-config';
import type { MailSearchOptions } from './mail-store';
import * as schema from './schema';

// What MailDB.size() answers, for a mail.db nobody has opened. Read-write on purpose: a WAL database nobody holds open
// has no -shm beside it, and a read-only open of one fails outright.
export function readMailIndexSize(dbPath: string): number {
    if (!fs.existsSync(dbPath)) return 0;
    const db = new Database(dbPath, { readwrite: true, create: false });
    try {
        db.run('PRAGMA busy_timeout = 5000;');
        const row = db.query<{ total: number }, []>('SELECT COALESCE(SUM(size), 0) AS total FROM emails').get();
        return row?.total ?? 0;
    } finally {
        db.close();
    }
}

// Left out of a default search. A search can still name them.
const SEARCH_EXCLUDED_MAILBOXES = [MAILBOX_TRASH, MAILBOX_JUNK];

// A list or search response carries the preview only; the FULL textShort stays in the DB for FTS5.
function cutPreview(row: typeof schema.emails.$inferSelect): EmailSummary {
    return row.textShort.length > MAIL_PREVIEW_CHARS
        ? { ...row, textShort: row.textShort.slice(0, MAIL_PREVIEW_CHARS) }
        : row;
}

export default class MailDB {
    private home: Home;
    private managedDb!: ManagedDatabase<typeof schema>;
    private db!: BunSQLiteDatabase<typeof schema>;

    public constructor(home: Home) {
        this.home = home;
    }

    public async init() {
        this.managedDb = await this.home.getLocalDatabase(MAIL_DB_CONFIG, PATHS.MAIL.DB);
        this.db = this.managedDb.db;
    }

    // By name, because callers hand in a full parsed Email, whose extra fields have no column here.
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

    // Upsert on the id, not a plain insert: a file whose id already has a row, such as a re-saved draft or one a crash
    // left in two mailboxes, would otherwise roll the whole chunk back on every sync. The caller credits what it replaces.
    public insertEmails(emails: EmailSummary[]): void {
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

    public size() {
        return this.db.select({ size: sql<number>`SUM(size)` }).from(schema.emails).get()?.size || 0;
    }

    // What an upsert chunk is about to replace. The byte counter needs it before insertEmails runs.
    public sumSizes(ids: string[]): number {
        if (ids.length === 0) return 0;
        return (
            this.db
                .select({ size: sql<number>`SUM(size)` })
                .from(schema.emails)
                .where(inArray(schema.emails.id, ids))
                .get()?.size || 0
        );
    }

    public getEmailsCount(mailbox: string) {
        return this.db.select({ count: count() }).from(schema.emails).where(eq(schema.emails.mailbox, mailbox)).get()!
            .count;
    }

    public getEmailsCountUnread(mailbox: string) {
        return this.db
            .select({ count: count() })
            .from(schema.emails)
            .where(and(eq(schema.emails.mailbox, mailbox), eq(schema.emails.isRead, false)))
            .get()!.count;
    }

    public getEmail(id: string) {
        return this.db.select().from(schema.emails).where(eq(schema.emails.id, id)).get();
    }

    public deleteEmail(id: string) {
        this.db.delete(schema.emails).where(eq(schema.emails.id, id)).run();
    }

    public moveEmail(id: string, mailbox: string) {
        this.db.update(schema.emails).set({ mailbox }).where(eq(schema.emails.id, id)).run();
    }

    public updateFlags(
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

    // A `SELECT *` would carry every row's `textShort`, the whole body kept for FTS, just to compare filenames.
    public listReconcileRows(mailbox: string) {
        return this.db
            .select({ id: schema.emails.id, filename: schema.emails.filename, size: schema.emails.size })
            .from(schema.emails)
            .where(eq(schema.emails.mailbox, mailbox))
            .all();
    }

    // Keyset pagination, newest first. `id` breaks a tie, because `date` has duplicates in practice.
    public listMessages(mailbox: string, opts: { limit: number; before?: { date: Date; id: string } }): EmailSummary[] {
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
        return rows.map(cutPreview);
    }

    public searchMail(opts: MailSearchOptions): EmailSummary[] {
        const match = sanitizeFtsQuery(opts.q);

        // A structured filter narrows to candidate ids first and FTS ranks within them, for exact recall at any selectivity.
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

        // from: or to: with no text term has no FTS query to score against, so recency ranks.
        if (!match) {
            if (!candidateIds) return [];
            const mailboxCond =
                opts.mailboxes && opts.mailboxes.length > 0
                    ? inArray(schema.emails.mailbox, opts.mailboxes)
                    : notInArray(schema.emails.mailbox, SEARCH_EXCLUDED_MAILBOXES);
            return this.db
                .select()
                .from(schema.emails)
                .where(and(inArray(schema.emails.id, candidateIds), mailboxCond))
                .orderBy(desc(schema.emails.date), desc(schema.emails.id))
                .limit(opts.limit)
                .all()
                .map(cutPreview);
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

        // Ids only: a raw `sql` result gets no Drizzle column-mode conversion, so the rows come in the next query.
        const ranked = this.db.all<{ id: string }>(sql`
            SELECT e.id AS id
            FROM emails_fts
            JOIN emails e ON e.rowid = emails_fts.rowid
            WHERE emails_fts MATCH ${match}${mailboxFilter}${candidateFilter}
            ORDER BY bm25(emails_fts), e.date DESC, e.id DESC
            LIMIT ${opts.limit}
        `);
        if (ranked.length === 0) return [];

        const ids = ranked.map((r) => r.id);
        const rows = this.db.select().from(schema.emails).where(inArray(schema.emails.id, ids)).all();
        const byId = new Map(rows.map((r) => [r.id, cutPreview(r)]));
        return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined);
    }

    public async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }
}
