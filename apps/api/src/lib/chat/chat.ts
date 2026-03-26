import {randomUUID} from 'crypto';
import {desc, eq, lt} from 'drizzle-orm';
import type {BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite';

import {type DrivePath, stripEigenExtension} from '@workspace/lib/types/drive';
import type {ChatMessage} from '@workspace/lib/types/chat';
import type {Drive} from '../drive';
import type {ManagedDatabase} from '../core/managed-database';
import {CHAT_ROOM_DB_CONFIG} from './db-config';
import * as schema from './schema';
import {buildChatEvent, buildCommentIndexUpdatedEvent} from './sse-events';
import {type CommentIndex, openCommentIndex} from './comment-index';
import {extractMentionedEmails} from './mentions';
import {type SSEvent, SSEventType} from '@workspace/lib/types/sse';
import type {Home} from '../home';
import {getHome} from '../home';
import {formatEmoteForViewer, parseCommand} from './commands';
import {validateEmailAddress} from '@workspace/lib/validation';
import {getUserByEmail} from '../user/';
import {ApiError} from '../core/errors';
import {atHome} from "../home/get-home.ts";

export class ChatRoom {
    private drive: Drive;
    private home: Home;
    private path: DrivePath;
    private containerPath: DrivePath | null = null;
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

        // Walk parentId chain to find outermost collab container (if any)
        this.containerPath = await this.drive.findContainerPath(
            this.path.mountId, this.path.parentId ?? ''
        );

        return this;
    }

    async postMessage(authorId: string, authorEmail: string, content: string, type: ChatMessage['type'] = 'message', whisperTo?: string, replyTo?: string, attachments?: string[]): Promise<ChatMessage> {
        if (content.startsWith('/') && type === 'message') {
            const cmd = parseCommand(content);
            switch (cmd.kind) {
                case 'builtin-emote':
                    type = 'emote';
                    content = cmd.target ? `$${cmd.emoteKey}:${cmd.target}` : `$${cmd.emoteKey}`;
                    break;
                case 'emote':
                    type = 'emote';
                    content = cmd.content;
                    break;
                case 'whisper':
                    type = 'whisper';
                    whisperTo = cmd.target;
                    content = cmd.content;
                    break;
                case 'error':
                    throw new ApiError(400, cmd.error);
                default:
                    break;
            }
        }

        if (type === 'whisper' && whisperTo) {
            if (!validateEmailAddress(whisperTo)) {
                throw new ApiError(400, `Invalid whisper target '${whisperTo}': must be a valid email address`);
            }
            const targetUser = await getUserByEmail(whisperTo);
            if (!targetUser) {
                throw new ApiError(404, `User '${whisperTo}' not found`);
            }
        }

        const id = randomUUID();
        const now = new Date();
        const attachmentData = attachments && attachments.length > 0 ? attachments : null;

        await this.db.insert(schema.messages).values({
            id,
            authorId,
            authorEmail,
            type,
            content,
            attachments: attachmentData,
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
            attachments: attachmentData,
            whisperTo: whisperTo ?? null,
            replyTo: replyTo ?? null,
            editedAt: null,
            deletedAt: null,
            createdAt: now,
        };

        const event = buildChatEvent(SSEventType.CHAT_MESSAGE_POSTED, {
            chatId: this.path.id,
            ownerId: this.path.ownerId,
            mountId: this.path.mountId,
        });
        this.home.broadcast(event);
        this.notifySharedUsers(event);

        // Update comment index if this chat is embedded in a container document
        if (this.containerPath && type !== 'whisper') {
            await this.updateCommentIndex(async (index) => {
                await index.ensureComment(this.path.name);
                await index.updateActivity(this.path.name, authorEmail, content);
                for (const email of extractMentionedEmails(content)) {
                    await index.addMention(this.path.name, email);
                }
            });
        }

        // Notify mentioned users (only those with read access)
        if (type !== 'whisper') {
            const mentionedEmails = extractMentionedEmails(content);
            if (mentionedEmails.length > 0) {
                const members = await this.drive.getEffectiveMembers(this.path.mountId, this.path.id);
                const memberEmails = new Set(members.map(m => m.email.toLowerCase()));
                const displayName = stripEigenExtension(this.containerPath?.name ?? this.path.name);
                const notificationType = this.containerPath ? 'mention-comment' : 'mention-chat';
                const targetPath = this.containerPath ?? this.path;

                for (const email of mentionedEmails) {
                    if (email === authorEmail.toLowerCase()) continue;
                    if (!memberEmails.has(email)) continue;
                    try {
                        const mentionedUser = await getUserByEmail(email);
                        if (!mentionedUser) continue;
                        const targetHome = await getHome(mentionedUser.id);
                        targetHome.notifications?.persist({
                            type: notificationType,
                            actorEmail: authorEmail,
                            title: `You were mentioned in "${displayName}"`,
                            body: content.length > 100 ? content.slice(0, 100) + '...' : content,
                            tag: `mention:${targetPath.ownerId}:${targetPath.mountId}:${targetPath.id}:${email}`,
                        });
                    } catch { /* user may not exist */
                    }
                }
            }
        }

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

    async getMessagesForUser(userId: string, userEmail: string, limit: number = 50, beforeId?: string): Promise<ChatMessage[]> {
        const allMessages = await this.getMessages(limit, beforeId);

        return allMessages.map(msg => {
            if (msg.type === 'whisper') {
                const isAuthor = msg.authorId === userId;
                const isRecipient = msg.whisperTo === userId || msg.whisperTo === userEmail;
                const targetName = msg.whisperTo?.split('@')[0] || msg.whisperTo || 'someone';
                if (isAuthor) {
                    return {...msg, content: `whispers to ${targetName}: ${msg.content}`};
                }
                if (isRecipient) {
                    return {...msg, content: `whispers to you: ${msg.content}`};
                }
                return {
                    ...msg,
                    content: `whispers to ${targetName}: [a few hushed words]`,
                    whisperTo: null,
                };
            }
            if (msg.type === 'emote' && !msg.deletedAt) {
                return {
                    ...msg,
                    content: formatEmoteForViewer(msg.content, msg.authorEmail, msg.authorId, userId, userEmail),
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

        const event = buildChatEvent(SSEventType.CHAT_MESSAGE_EDITED, {
            chatId: this.path.id,
            ownerId: this.path.ownerId,
            mountId: this.path.mountId,
        });
        this.home.broadcast(event);
        this.notifySharedUsers(event);

        if (this.containerPath && existing.type !== 'whisper') {
            await this.updateCommentIndex(async (index) => {
                await index.updateActivity(this.path.name, existing.authorEmail, content, false);
                for (const email of extractMentionedEmails(content)) {
                    await index.addMention(this.path.name, email);
                }
            });
        }

        return updated;
    }

    async deleteMessage(messageId: string, userId: string): Promise<boolean> {
        const existing = await this.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!existing || existing.authorId !== userId) return false;

        const now = new Date();
        await this.db.update(schema.messages)
            .set({deletedAt: now, content: ''})
            .where(eq(schema.messages.id, messageId));

        if (existing.attachments) {
            const attachmentIds = existing.attachments as string[];
            for (const attachmentId of attachmentIds) {
                try {
                    await this.drive.deleteFile(this.path.mountId, attachmentId);
                } catch {
                    // attachment may already be deleted
                }
            }
        }

        const event = buildChatEvent(SSEventType.CHAT_MESSAGE_DELETED, {
            chatId: this.path.id,
            ownerId: this.path.ownerId,
            mountId: this.path.mountId,
        });
        this.home.broadcast(event);
        this.notifySharedUsers(event);

        if (this.containerPath && existing.type !== 'whisper') {
            await this.updateCommentIndex(async (index) => {
                await index.decrementCount(this.path.name);
            });
        }

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

    private async updateCommentIndex(fn: (index: CommentIndex) => Promise<void>) {
        if (!this.containerPath) return;
        try {
            const index = await openCommentIndex(this.drive, this.containerPath);
            await fn(index);

            const event = buildCommentIndexUpdatedEvent(
                this.containerPath.id, this.path.ownerId, this.path.mountId
            );
            this.home.broadcast(event);
            this.notifySharedUsers(event);
        } catch (error) {
            console.error('Failed to update comment index:', error);
        }
    }

    // Uses getEffectiveMembers to resolve all users with access — handles inherited
    // ACL from parent folders, team membership, and container document ACL.
    private async notifySharedUsers(event: SSEvent) {
        const members = await this.drive.getEffectiveMembers(this.path.mountId, this.path.id);
        for (const member of members) {
            const user = await getUserByEmail(member.email);
            if (!user) continue;
            try {
                if (atHome(user.id)) {
                    const home = await getHome(user.id);
                    home.broadcast(event);
                }
            } catch { /* user home may not exist */
            }
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
