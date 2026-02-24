import {randomUUID} from 'crypto';
import {eq, desc, lt} from 'drizzle-orm';
import type {BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite';

import type {DrivePath} from '@workspace/lib/types/drive';
import type {ChatMessage} from '@workspace/lib/types/chat';
import type {Drive} from '../drive';
import type {ManagedDatabase} from '../core/managed-database';
import {CHAT_ROOM_DB_CONFIG} from './db-config';
import * as schema from './schema';
import {buildChatEvent} from './sse-events';
import {SSEventType} from '@workspace/lib/types/sse';
import type {Home} from '../home';

export class ChatRoom {
    private drive: Drive;
    private home: Home;
    private path: DrivePath;
    private db!: BunSQLiteDatabase<typeof schema>;
    private managedDb!: ManagedDatabase<typeof schema>;

    constructor(drive: Drive, home: Home, path: DrivePath) {
        this.drive = drive;
        this.home = home;
        this.path = path;
    }

    static async create(drive: Drive, mountId: string, roomId: string): Promise<void> {
        await drive.touchFile(mountId, roomId, 'data.db', 'application/x-sqlite3');
        await drive.createFolder(mountId, roomId, 'media');
    }

    async init(): Promise<ChatRoom> {
        let dataDbPath = await this.drive.getChildByName(this.path.mountId, this.path.id, 'data.db');
        if (!dataDbPath) {
            await ChatRoom.create(this.drive, this.path.mountId, this.path.id);
            dataDbPath = await this.drive.getChildByName(this.path.mountId, this.path.id, 'data.db');
            if (!dataDbPath) {
                throw new Error(`Failed to create data.db in ${this.path.name}`);
            }
        }

        this.managedDb = await this.drive.openDatabase(this.path.mountId, CHAT_ROOM_DB_CONFIG, dataDbPath.id);
        this.db = this.managedDb.db;
        return this;
    }

    async postMessage(authorId: string, authorEmail: string, content: string, type: ChatMessage['type'] = 'message', whisperTo?: string, replyTo?: string): Promise<ChatMessage> {
        const id = randomUUID();
        const now = new Date();

        await this.db.insert(schema.messages).values({
            id,
            authorId,
            authorEmail,
            type,
            content,
            whisperTo: whisperTo ?? null,
            replyTo: replyTo ?? null,
            createdAt: now,
        });

        const message: ChatMessage = {
            id,
            authorId,
            authorEmail,
            type,
            content,
            attachments: null,
            whisperTo: whisperTo ?? null,
            replyTo: replyTo ?? null,
            editedAt: null,
            deletedAt: null,
            createdAt: now,
        };

        this.home.notify(buildChatEvent(SSEventType.CHAT_MESSAGE_POSTED, {
            chatId: this.path.id,
            ownerId: this.path.ownerId,
            mountId: this.path.mountId,
            message,
        }));

        return message;
    }

    async getMessages(limit: number = 50, beforeId?: string): Promise<ChatMessage[]> {
        let rows;
        if (beforeId) {
            const beforeMsg = await this.db.select().from(schema.messages).where(eq(schema.messages.id, beforeId)).get();
            if (!beforeMsg) return [];
            rows = await this.db.select().from(schema.messages)
                .where(lt(schema.messages.createdAt, beforeMsg.createdAt))
                .orderBy(desc(schema.messages.createdAt))
                .limit(limit)
                .all();
        } else {
            rows = await this.db.select().from(schema.messages)
                .orderBy(desc(schema.messages.createdAt))
                .limit(limit)
                .all();
        }

        return rows.map(r => this.toMessage(r)).reverse();
    }

    async getMessagesForUser(userId: string, limit: number = 50, beforeId?: string): Promise<ChatMessage[]> {
        const allMessages = await this.getMessages(limit, beforeId);

        return allMessages.map(msg => {
            if (msg.type === 'whisper') {
                if (msg.authorId === userId || msg.whisperTo === userId) {
                    return msg;
                }
                return {
                    ...msg,
                    content: '',
                    whisperTo: null,
                };
            }
            return msg;
        });
    }

    async editMessage(messageId: string, content: string, userId: string): Promise<ChatMessage | null> {
        const existing = await this.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!existing || existing.authorId !== userId) return null;

        const now = new Date();
        await this.db.update(schema.messages)
            .set({content, editedAt: now})
            .where(eq(schema.messages.id, messageId));

        const updated = this.toMessage({...existing, content, editedAt: now});

        this.home.notify(buildChatEvent(SSEventType.CHAT_MESSAGE_EDITED, {
            chatId: this.path.id,
            ownerId: this.path.ownerId,
            mountId: this.path.mountId,
            message: updated,
        }));

        return updated;
    }

    async deleteMessage(messageId: string, userId: string): Promise<boolean> {
        const existing = await this.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!existing || existing.authorId !== userId) return false;

        const now = new Date();
        await this.db.update(schema.messages)
            .set({deletedAt: now})
            .where(eq(schema.messages.id, messageId));

        this.home.notify(buildChatEvent(SSEventType.CHAT_MESSAGE_DELETED, {
            chatId: this.path.id,
            ownerId: this.path.ownerId,
            mountId: this.path.mountId,
            message: this.toMessage({...existing, deletedAt: now}),
        }));

        return true;
    }

    async markRead(userId: string, messageId: string): Promise<void> {
        const now = new Date();
        const existing = await this.db.select().from(schema.readState).where(eq(schema.readState.userId, userId)).get();
        if (existing) {
            await this.db.update(schema.readState)
                .set({lastReadMessageId: messageId, lastReadAt: now})
                .where(eq(schema.readState.userId, userId));
        } else {
            await this.db.insert(schema.readState).values({
                userId,
                lastReadMessageId: messageId,
                lastReadAt: now,
            });
        }
    }

    private toMessage(row: typeof schema.messages.$inferSelect): ChatMessage {
        return {
            id: row.id,
            authorId: row.authorId,
            authorEmail: row.authorEmail,
            type: row.type,
            content: row.content,
            attachments: row.attachments ?? null,
            whisperTo: row.whisperTo ?? null,
            replyTo: row.replyTo ?? null,
            editedAt: row.editedAt ?? null,
            deletedAt: row.deletedAt ?? null,
            createdAt: row.createdAt,
        };
    }
}
