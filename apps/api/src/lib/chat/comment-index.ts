// The comment index of one document: a comments.db in the document's folder, with a row per comment
// thread. A row holds what the comments panel shows, such as the status, the assignee and the message
// count, and the newest text of the thread for comment search. For example, a chat room updates it
// after each post, and the comment routes list, search and resolve its threads.

import type { CommentEntry } from '@workspace/lib/types/chat';
import type { DocCommentMatch } from '@workspace/lib/types/doc-search';
import { DRIVE_MIME_CHAT } from '@workspace/lib/types/drive';
import { eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { sanitizeFtsQuery } from '../core';
import { ApiError } from '../core/errors';
import type { DriveLike } from '../drive/get-drive';
import { COMMENT_INDEX_DB_CONFIG } from './comment-db-config';
import * as commentSchema from './comment-schema';

// Comment search indexes only the newest 8192 characters of each thread. Older text can't be found.
export const RECENT_TEXT_CAP = 8192;
const COMMENT_SEARCH_LIMIT = 8;

export class CommentIndex {
    public constructor(private readonly db: BunSQLiteDatabase<typeof commentSchema>) {}

    public async ensureComment(chatName: string, seed?: { createdBy?: string | null }): Promise<void> {
        await this.db
            .insert(commentSchema.comments)
            .values({ chatName, createdBy: seed?.createdBy ?? null })
            .onConflictDoUpdate({
                target: commentSchema.comments.chatName,
                // A row that has a creator keeps it. Only a missing creator is filled in.
                set: {
                    createdBy: sql`COALESCE(${commentSchema.comments.createdBy}, EXCLUDED.createdBy)`,
                },
            });
    }

    public async updateActivity(chatName: string, authorEmail: string, incrementCount = true): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({
                lastAuthorEmail: authorEmail,
                lastActivityAt: new Date(),
                ...(incrementCount && { messageCount: sql`messageCount + 1` }),
            })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    public async setRecentText(chatName: string, recentText: string | null): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({ recentText })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    public async addMention(chatName: string, email: string): Promise<void> {
        await this.db
            .insert(commentSchema.commentMentions)
            .values({ chatName, email: email.toLowerCase() })
            .onConflictDoNothing();
    }

    public async resolve(chatName: string, email: string): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({ status: 'resolved', resolvedBy: email, resolvedAt: new Date() })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    public async reopen(chatName: string): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({ status: 'open', resolvedBy: null, resolvedAt: null })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    public async assign(chatName: string, email: string | null): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({ assignee: email })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    public async setTitle(chatName: string, title: string): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({ title })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    public async decrementCount(chatName: string): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({ messageCount: sql`MAX(0, messageCount - 1)` })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    // Drops the rows and the mentions of every thread hasThread no longer finds, in one transaction, and returns how
    // many threads that was. The mentions have no foreign key, so they go by name. The search table follows the rows
    // through its delete trigger. It runs without an await, so a thread made meanwhile is either found or has no row.
    public deleteRowsWithoutThread(hasThread: (chatName: string) => boolean): number {
        const { comments, commentMentions } = commentSchema;
        return this.db.transaction((tx) => {
            const names = new Set(
                [
                    ...tx.select({ chatName: comments.chatName }).from(comments).all(),
                    ...tx.select({ chatName: commentMentions.chatName }).from(commentMentions).all(),
                ].map((row) => row.chatName),
            );
            const gone = [...names].filter((chatName) => !hasThread(chatName));
            if (gone.length === 0) return 0;
            tx.delete(comments).where(inArray(comments.chatName, gone)).run();
            tx.delete(commentMentions).where(inArray(commentMentions.chatName, gone)).run();
            return gone.length;
        });
    }

    public async get(chatName: string): Promise<typeof commentSchema.comments.$inferSelect | undefined> {
        return this.db.select().from(commentSchema.comments).where(eq(commentSchema.comments.chatName, chatName)).get();
    }

    // The list holds only what the comments panel shows. The search text can be RECENT_TEXT_CAP
    // characters a thread, and no client reads the creator.
    public async list(): Promise<CommentEntry[]> {
        const { comments } = commentSchema;
        const { recentText: _text, createdBy: _by, ...columns } = getTableColumns(comments);
        return this.db.select(columns).from(comments).orderBy(comments.createdAt).all();
    }

    public async searchComments(query: string): Promise<DocCommentMatch[]> {
        const match = sanitizeFtsQuery(query);
        if (!match) return [];

        // FTS5 ranks the threads and cuts an excerpt around each match. The FTS table keeps no copy of
        // the text, so snippet() reads it back from the comments table.
        const ranked = this.db.all<{ chatName: string; snippet: string }>(sql`
            SELECT c.chatName AS chatName,
                   snippet(comments_fts, 0, '', '', '…', 10) AS snippet
            FROM comments_fts
            JOIN comments c ON c.rowid = comments_fts.rowid
            WHERE comments_fts MATCH ${match}
            ORDER BY bm25(comments_fts)
            LIMIT ${COMMENT_SEARCH_LIMIT}
        `);
        if (ranked.length === 0) return [];

        // The matched rows add who spoke last. The result keeps the ranked order.
        const names = ranked.map((r) => r.chatName);
        const rows = await this.db
            .select()
            .from(commentSchema.comments)
            .where(inArray(commentSchema.comments.chatName, names))
            .all();
        const byName = new Map(rows.map((r) => [r.chatName, r]));

        return ranked.map((r) => ({
            // The client finds the comment card for this chatName to reveal it.
            id: r.chatName,
            label: r.snippet,
            context: byName.get(r.chatName)?.lastAuthorEmail ?? undefined,
        }));
    }
}

// Runs fn on the index of the document at pathId, with its comments.db open for just that long.
// Through a SharedDrive, the lookup of comments.db checks that the caller may read the document. A
// plain Drive belongs to the caller, so nothing is checked.
export async function withCommentIndex<T>(
    drive: DriveLike,
    mountId: string,
    pathId: string,
    fn: (index: CommentIndex) => Promise<T>,
): Promise<T> {
    const dbPath = await drive.getChildByName(mountId, pathId, 'comments.db');
    if (!dbPath) throw new ApiError(404, 'comments.db not found');
    return drive.withDatabase(mountId, COMMENT_INDEX_DB_CONFIG, dbPath.id, (managed) =>
        fn(new CommentIndex(managed.db)),
    );
}

// Callers run this before ensureComment. ensureComment may add the missing row of an older thread
// that is real. A made-up chatName must never get a row, because the row would bring a history event
// and a notification that links nowhere. A comment thread is a chat in the document's chat folder.
export async function assertCommentChatExists(
    drive: DriveLike,
    mountId: string,
    containerId: string,
    chatName: string,
): Promise<void> {
    const chatFolder = await drive.getChildByName(mountId, containerId, 'chat');
    const chat = chatFolder ? await drive.getChildByName(mountId, chatFolder.id, chatName) : null;
    if (chat?.mimeType !== DRIVE_MIME_CHAT) throw new ApiError(404, 'Comment thread not found');
}
