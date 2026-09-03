import type { CommentEntry } from '@workspace/lib/types/chat';
import type { DocCommentMatch } from '@workspace/lib/types/doc-search';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_CHAT } from '@workspace/lib/types/drive';
import { eq, inArray, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { sanitizeFtsQuery } from '../core';
import { ApiError } from '../core/errors';
import type { DriveLike } from '../drive/get-drive';
import { COMMENT_INDEX_DB_CONFIG } from './comment-db-config';
import * as commentSchema from './comment-schema';

// Newest-first tail per thread that comment search indexes (~8 KB). Older text past the cap
// falls off and stops being searchable — the stated phase-2 limitation. chat.ts's recompute
// caps against it.
export const RECENT_TEXT_CAP = 8192;
const COMMENT_SEARCH_LIMIT = 8;

export class CommentIndex {
    private db: BunSQLiteDatabase<typeof commentSchema>;

    constructor(db: BunSQLiteDatabase<typeof commentSchema>) {
        this.db = db;
    }

    async ensureComment(chatName: string, seed?: { createdBy?: string | null; createdAt?: Date }): Promise<void> {
        const values: typeof commentSchema.comments.$inferInsert = {
            chatName,
            createdAt: seed?.createdAt ?? new Date(),
            createdBy: seed?.createdBy ?? null,
        };

        await this.db
            .insert(commentSchema.comments)
            .values(values)
            .onConflictDoUpdate({
                target: commentSchema.comments.chatName,
                // COALESCE: only fill createdBy when currently NULL; never overwrite a real value.
                set: {
                    createdBy: sql`COALESCE(${commentSchema.comments.createdBy}, EXCLUDED.createdBy)`,
                },
            });
    }

    async updateActivity(chatName: string, authorEmail: string, snippet: string, incrementCount = true): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({
                lastAuthorEmail: authorEmail,
                lastMessageSnippet: snippet.slice(0, 100),
                lastActivityAt: new Date(),
                ...(incrementCount && { messageCount: sql`messageCount + 1` }),
            })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    async setRecentText(chatName: string, recentText: string | null): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({ recentText })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    async addMention(chatName: string, email: string): Promise<void> {
        await this.db
            .insert(commentSchema.commentMentions)
            .values({ chatName, email: email.toLowerCase() })
            .onConflictDoNothing();
    }

    async resolve(chatName: string, email: string): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({ status: 'resolved', resolvedBy: email, resolvedAt: new Date() })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    async reopen(chatName: string): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({ status: 'open', resolvedBy: null, resolvedAt: null })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    async assign(chatName: string, email: string | null): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({ assignee: email })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    async setTitle(chatName: string, title: string): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({ title })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    async decrementCount(chatName: string): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({ messageCount: sql`MAX(0, messageCount - 1)` })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    async get(chatName: string): Promise<CommentEntry | undefined> {
        return this.db.select().from(commentSchema.comments).where(eq(commentSchema.comments.chatName, chatName)).get();
    }

    async list(): Promise<CommentEntry[]> {
        return this.db.select().from(commentSchema.comments).orderBy(commentSchema.comments.createdAt).all();
    }

    async searchComments(query: string): Promise<DocCommentMatch[]> {
        const match = sanitizeFtsQuery(query);
        if (!match) return [];

        // Pass 1: rank via FTS5; pull each thread's chatName + a highlighted excerpt of the matched
        // recentText. snippet() reads the column back through the external-content table.
        const ranked = this.db.all(sql`
            SELECT c.chatName AS chatName,
                   snippet(comments_fts, 0, '', '', '…', 10) AS snippet
            FROM comments_fts
            JOIN comments c ON c.rowid = comments_fts.rowid
            WHERE comments_fts MATCH ${match}
            ORDER BY bm25(comments_fts)
            LIMIT ${COMMENT_SEARCH_LIMIT}
        `) as { chatName: string; snippet: string }[];
        if (ranked.length === 0) return [];

        // Pass 2: hydrate the ranked threads for context (who last spoke), order-preserving.
        const names = ranked.map((r) => r.chatName);
        const rows = await this.db
            .select()
            .from(commentSchema.comments)
            .where(inArray(commentSchema.comments.chatName, names))
            .all();
        const byName = new Map(rows.map((r) => [r.chatName, r]));

        return ranked.map((r) => ({
            // id is the thread's chatName; the FE reveal resolves chatName → cardId client-side.
            id: r.chatName,
            label: r.snippet,
            context: byName.get(r.chatName)?.lastAuthorEmail ?? undefined,
        }));
    }
}

export async function openCommentIndex(drive: DriveLike, containerPath: DrivePath): Promise<CommentIndex> {
    const dbPath = await drive.getChildByName(containerPath.mountId, containerPath.id, 'comments.db');
    if (!dbPath) throw new ApiError(404, 'comments.db not found');
    const managed = await drive.openDatabase(containerPath.mountId, COMMENT_INDEX_DB_CONFIG, dbPath.id);
    return new CommentIndex(managed.db);
}

// Convenience: resolves path + opens index. When called with a SharedDrive, getPath enforces
// read permission; raw Drive callers (own-drive paths) skip the check intentionally.
export async function getCommentIndex(drive: DriveLike, mountId: string, pathId: string): Promise<CommentIndex> {
    const path = await drive.getPath(mountId, pathId);
    if (!path) throw new ApiError(404, 'Container not found');
    return openCommentIndex(drive, path);
}

// Reject an unknown chatName before ensureComment: it may heal a REAL legacy thread missing its
// index row, but must never mint a row (+ 'assigned' event + dead-link notification) for a phantom
// name. Chats live at <container>/chat/<chatName>; require a real .eigenchat there.
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
