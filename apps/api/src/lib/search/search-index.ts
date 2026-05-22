import { and, eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

export type SearchKind = 'mail';

export type SearchDoc = {
    kind: SearchKind;
    itemId: string;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
    sortKey: number;
};

export type SearchHit = Omit<SearchDoc, 'body'>;

type FtsRow = {
    kind: string;
    itemId: string;
    title: string;
    metadata: string;
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
                const metadata = JSON.stringify(doc.metadata);
                tx.insert(schema.searchContent)
                    .values({
                        kind: doc.kind,
                        itemId: doc.itemId,
                        title: doc.title,
                        body: doc.body,
                        metadata,
                        sortKey: doc.sortKey,
                    })
                    .onConflictDoUpdate({
                        target: [schema.searchContent.kind, schema.searchContent.itemId],
                        set: { title: doc.title, body: doc.body, metadata, sortKey: doc.sortKey },
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

    query(text: string, limit: number): SearchHit[] {
        const match = sanitizeFtsQuery(text);
        if (!match) return [];

        const rows = this.db.all(sql`
            SELECT c.kind AS kind, c.itemId AS itemId, c.title AS title,
                   c.metadata AS metadata, c.sortKey AS sortKey
            FROM search_fts
            JOIN search_content c ON c.rowid = search_fts.rowid
            WHERE search_fts MATCH ${match}
            ORDER BY bm25(search_fts), c.sortKey DESC
            LIMIT ${limit}
        `) as FtsRow[];

        return rows.map((row) => ({
            kind: row.kind as SearchKind,
            itemId: row.itemId,
            title: row.title,
            metadata: JSON.parse(row.metadata) as Record<string, unknown>,
            sortKey: row.sortKey,
        }));
    }
}
