import { and, eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

export type SearchKind = 'mail';

export type SearchDoc = {
    kind: SearchKind;
    itemId: string;
    bucket: string;
    title: string;
    body: string;
    sortKey: number;
};

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

export class SearchIndex {
    constructor(private db: BunSQLiteDatabase<typeof schema>) {}

    upsert(doc: SearchDoc): void {
        this.upsertBatch([doc]);
    }

    // Upserts many docs in a single transaction — far fewer fsyncs than one-by-one, which is
    // what makes the backfill cheap. A single-doc upsert is just a one-element batch.
    upsertBatch(docs: SearchDoc[]): void {
        if (docs.length === 0) return;
        this.db.transaction((tx) => {
            for (const doc of docs) {
                tx.insert(schema.searchContent)
                    .values({
                        kind: doc.kind,
                        itemId: doc.itemId,
                        bucket: doc.bucket,
                        title: doc.title,
                        body: doc.body,
                        sortKey: doc.sortKey,
                    })
                    .onConflictDoUpdate({
                        target: [schema.searchContent.kind, schema.searchContent.itemId],
                        set: { bucket: doc.bucket, title: doc.title, body: doc.body, sortKey: doc.sortKey },
                    })
                    .run();
            }
        });
    }

    delete(kind: SearchKind, itemId: string): void {
        this.db
            .delete(schema.searchContent)
            .where(and(eq(schema.searchContent.kind, kind), eq(schema.searchContent.itemId, itemId)))
            .run();
    }

    isEmpty(): boolean {
        return (
            this.db.select({ rowid: schema.searchContent.rowid }).from(schema.searchContent).limit(1).get() ===
            undefined
        );
    }

    // Returns itemIds in `bm25() ASC, sortKey DESC` order. Display data lives in each domain's
    // canonical store — callers look the ids up there. `bucket` and `sortKey` stay in the SQL
    // (filter + order) but never leave the index; the caller already knows the kind from the
    // search.db file it queried.
    query(
        text: string,
        limit: number,
        opts?: { buckets?: string[]; excludeBuckets?: string[]; itemIds?: string[] },
    ): string[] {
        const match = sanitizeFtsQuery(text);
        if (!match) return [];
        // An empty allowlist would generate a WHERE clause that matches nothing; short-circuit
        // so callers don't need to special-case it.
        if (opts?.itemIds && opts.itemIds.length === 0) return [];

        let bucketFilter = sql``;
        // When both are provided, `buckets` (allowlist) takes precedence over `excludeBuckets`.
        if (opts?.buckets?.length) {
            const list = sql.join(
                opts.buckets.map((b) => sql`${b}`),
                sql`, `,
            );
            bucketFilter = sql` AND c.bucket IN (${list})`;
        } else if (opts?.excludeBuckets?.length) {
            const list = sql.join(
                opts.excludeBuckets.map((b) => sql`${b}`),
                sql`, `,
            );
            bucketFilter = sql` AND c.bucket NOT IN (${list})`;
        }

        let itemIdFilter = sql``;
        if (opts?.itemIds?.length) {
            const list = sql.join(
                opts.itemIds.map((id) => sql`${id}`),
                sql`, `,
            );
            itemIdFilter = sql` AND c.itemId IN (${list})`;
        }

        const rows = this.db.all(sql`
            SELECT c.itemId AS itemId
            FROM search_fts
            JOIN search_content c ON c.rowid = search_fts.rowid
            WHERE search_fts MATCH ${match}${bucketFilter}${itemIdFilter}
            ORDER BY bm25(search_fts), c.sortKey DESC, c.itemId DESC
            LIMIT ${limit}
        `) as { itemId: string }[];

        return rows.map((row) => row.itemId);
    }
}
