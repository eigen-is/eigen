import type { CommentEntry } from '@workspace/lib/types/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { ApiError } from '../core/errors';
import type { Drive, SharedDrive } from '../drive';
import { COMMENT_INDEX_DB_CONFIG } from './comment-db-config';
import * as commentSchema from './comment-schema';

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

    async decrementCount(chatName: string): Promise<void> {
        await this.db
            .update(commentSchema.comments)
            .set({ messageCount: sql`MAX(0, messageCount - 1)` })
            .where(eq(commentSchema.comments.chatName, chatName));
    }

    async list(): Promise<CommentEntry[]> {
        const comments = await this.db
            .select()
            .from(commentSchema.comments)
            .orderBy(commentSchema.comments.createdAt)
            .all();
        const mentions = await this.db.select().from(commentSchema.commentMentions).all();

        const mentionsByChat = new Map<string, string[]>();
        for (const m of mentions) {
            const list = mentionsByChat.get(m.chatName);
            if (list) list.push(m.email);
            else mentionsByChat.set(m.chatName, [m.email]);
        }

        return comments.map((c) => ({
            ...c,
            mentions: mentionsByChat.get(c.chatName) ?? [],
        }));
    }
}

export async function openCommentIndex(drive: Drive | SharedDrive, containerPath: DrivePath): Promise<CommentIndex> {
    const dbPath = await drive.getChildByName(containerPath.mountId, containerPath.id, 'comments.db');
    if (!dbPath) throw new ApiError(404, 'comments.db not found');
    const managed = await drive.openDatabase(containerPath.mountId, COMMENT_INDEX_DB_CONFIG, dbPath.id);
    return new CommentIndex(managed.db);
}

export async function tryOpenCommentIndex(
    drive: Drive | SharedDrive,
    containerPath: DrivePath,
): Promise<CommentIndex | null> {
    const dbPath = await drive.getChildByName(containerPath.mountId, containerPath.id, 'comments.db');
    if (!dbPath) return null;
    const managed = await drive.openDatabase(containerPath.mountId, COMMENT_INDEX_DB_CONFIG, dbPath.id);
    return new CommentIndex(managed.db);
}

// Convenience: resolves path + opens index. When called with a SharedDrive, getPath enforces
// read permission; raw Drive callers (own-drive paths) skip the check intentionally.
export async function getCommentIndex(
    drive: Drive | SharedDrive,
    mountId: string,
    pathId: string,
): Promise<CommentIndex> {
    const path = await drive.getPath(mountId, pathId);
    if (!path) throw new ApiError(404, 'Container not found');
    return openCommentIndex(drive, path);
}
