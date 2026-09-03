import { randomUUID } from 'node:crypto';
import type { ChatAttachment, ChatMessage } from '@workspace/lib/types/chat';
import { type DrivePath, type EffectiveMember, stripEigenExtension } from '@workspace/lib/types/drive';
import { type SSEvent, SSEventType } from '@workspace/lib/types/sse';
import { validateEmailAddress } from '@workspace/lib/validation';
import { and, desc, eq, isNull, lt, ne } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { ApiError } from '../core/errors';
import type { ManagedDatabase } from '../core/managed-database';
import type { Drive } from '../drive';
import type { Home } from '../home';
import { relayEventToMembers, sendToHome } from '../home/home-relay';
import { getUserByEmail, type User } from '../user/';
import { formatEmoteForViewer, parseCommand } from './commands';
import { type CommentIndex, openCommentIndex, RECENT_TEXT_CAP } from './comment-index';
import { CHAT_ROOM_DB_CONFIG } from './db-config';
import { extractMentionedEmails } from './mentions';
import * as schema from './schema';
import { buildChatEvent, buildCommentIndexUpdatedEvent } from './sse-events';

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
        // Atomic provision so a transient storage failure can't leave a
        // dead-letter data.db row that would make every subsequent
        // ChatRoom.init throw 503.
        await drive.provisionManagedDbs(mountId, roomId, [{ name: 'data.db', config: CHAT_ROOM_DB_CONFIG }]);
        await drive.createFolder(mountId, roomId, 'media');
    }

    async init(): Promise<ChatRoom> {
        let dataDbPath = await this.drive.getChildByName(this.path.mountId, this.path.id, 'data.db');
        if (!dataDbPath) {
            // Provision the missing data.db under the container lock and re-check under it. A
            // concurrent version restore (replaceContainerDataDb) holds this same lock while it
            // deletes and recreates data.db, and Drive.getChat builds a fresh ChatRoom per request.
            // Without the lock a post landing in the delete→recreate window would provision a second
            // empty data.db, the restore's createFileFromTemp would then 4xx on the duplicate name,
            // and the chat would be left on the empty db with its earlier messages gone.
            dataDbPath = await this.drive.withPathLock(this.path.mountId, this.path.id, async () => {
                const existing = await this.drive.getChildByName(this.path.mountId, this.path.id, 'data.db');
                if (existing) return existing;
                await ChatRoom.create(this.drive, this.path.mountId, this.path.id);
                const created = await this.drive.getChildByName(this.path.mountId, this.path.id, 'data.db');
                if (!created) throw new ApiError(500, `Failed to create data.db in ${this.path.name}`);
                return created;
            });
        }

        // openDatabase (potentially cold S3 GET) and findContainerPath
        // (local metadata walk) don't depend on each other — run concurrently.
        const dataDbId = dataDbPath.id;
        const [managedDb, containerPath] = await Promise.all([
            this.drive.openDatabase(this.path.mountId, CHAT_ROOM_DB_CONFIG, dataDbId),
            this.drive.findContainerPath(this.path.mountId, this.path.parentId ?? ''),
        ]);
        this.managedDb = managedDb;
        this.db = this.managedDb.db;
        this.containerPath = containerPath;

        return this;
    }

    async postMessage(
        author: User,
        content: string,
        type: ChatMessage['type'] = 'message',
        whisperTo?: string,
        replyTo?: string,
        attachments?: ChatAttachment[],
    ): Promise<ChatMessage> {
        const { id: authorId, email: authorEmail } = author;
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

        // Resolved once here and reused by the comment-index relay and the notification fan-out
        // below — each getEffectiveMembers is a full ACL/team walk (mirrors edit/deleteMessage).
        const members = await this.drive.getEffectiveMembers(this.path.mountId, this.path.id);

        // Update comment index if this chat is embedded in a container document
        if (this.containerPath && type !== 'whisper') {
            await this.updateCommentIndex(async (index) => {
                await index.ensureComment(this.path.name, { createdBy: authorEmail });
                await index.updateActivity(this.path.name, authorEmail, content);
                for (const email of extractMentionedEmails(content)) {
                    await index.addMention(this.path.name, email);
                }
            }, members);
        }

        // Notifications: mentions + activity. This guard also gates the cross-home
        // SSE relay (notifySharedUsers) — harmless today since 'system' messages aren't
        // postable via any route; revisit if that changes so the relay still fires for them.
        if (type !== 'system') {
            this.notifySharedUsers(event, members); // fire-and-forget, members already resolved

            const displayName = stripEigenExtension(this.containerPath?.name ?? this.path.name);
            const targetPath = this.containerPath ?? this.path;
            const body = content.length > 100 ? `${content.slice(0, 100)}...` : content;
            const memberEmails = new Set(members.map((m) => m.email.toLowerCase()));

            // Mention notifications (non-whisper only). Populate the set synchronously first — the
            // activity loop below filters on it — then fan out the sends concurrently (mirrors
            // notifyWatchers): each getUserByEmail + sendToHome is an independent auth-db/home
            // round-trip, isolated so one failure never rejects the batch or delays the sender.
            const mentionedEmailSet = new Set<string>();
            if (type !== 'whisper') {
                const mentionTitle = `${author.name} mentioned you in "${displayName}"`;
                for (const email of extractMentionedEmails(content)) {
                    if (email === authorEmail.toLowerCase()) continue;
                    if (!memberEmails.has(email)) continue;
                    mentionedEmailSet.add(email);
                }
                await Promise.all(
                    [...mentionedEmailSet].map(async (email) => {
                        try {
                            const mentionedUser = await getUserByEmail(email);
                            if (!mentionedUser) return;
                            await sendToHome(mentionedUser.id, {
                                type: 'notification',
                                notification: this.containerPath
                                    ? {
                                          type: 'mention-comment',
                                          actorEmail: authorEmail,
                                          title: mentionTitle,
                                          body,
                                          tag: `mention:${targetPath.ownerId}:${targetPath.mountId}:${targetPath.id}:${this.path.name}:${email}`,
                                          details: { pathType: this.containerPath.type },
                                      }
                                    : {
                                          type: 'mention-chat',
                                          actorEmail: authorEmail,
                                          title: mentionTitle,
                                          body,
                                          tag: `mention:${targetPath.ownerId}:${targetPath.mountId}:${targetPath.id}:${email}`,
                                      },
                            });
                        } catch {
                            // user or home may not exist
                        }
                    }),
                );
            }

            // Activity notifications: whispers → recipient only, messages/emotes → previous participants + owner
            const activityNotifiedEmails = new Set<string>();
            const notifyActivity = async (userId: string) => {
                try {
                    await sendToHome(userId, {
                        type: 'notification',
                        notification: this.containerPath
                            ? {
                                  type: 'comment-reply',
                                  actorEmail: authorEmail,
                                  title: `${author.name} commented on "${displayName}"`,
                                  body,
                                  tag: `comment-reply:${targetPath.ownerId}:${targetPath.mountId}:${targetPath.id}:${this.path.name}`,
                                  details: { pathType: this.containerPath.type },
                              }
                            : {
                                  type: 'chat-message',
                                  actorEmail: authorEmail,
                                  title: `New message from ${author.name} in "${displayName}"`,
                                  body,
                                  tag: `chat-message:${targetPath.ownerId}:${targetPath.mountId}:${targetPath.id}`,
                              },
                    });
                } catch {
                    // user home may not exist
                }
            };

            if (type === 'whisper' && whisperTo) {
                if (
                    whisperTo.toLowerCase() !== authorEmail.toLowerCase() &&
                    memberEmails.has(whisperTo.toLowerCase())
                ) {
                    const recipientUser = await getUserByEmail(whisperTo);
                    if (recipientUser) await notifyActivity(recipientUser.id);
                }
            } else if (type === 'message' || type === 'emote') {
                const participants = new Map<string, string>();
                const rows = await this.db
                    .selectDistinct({ authorId: schema.messages.authorId, authorEmail: schema.messages.authorEmail })
                    .from(schema.messages)
                    .where(isNull(schema.messages.deletedAt))
                    .all();
                for (const row of rows) {
                    participants.set(row.authorEmail.toLowerCase(), row.authorId);
                }
                participants.set(this.home.user.email.toLowerCase(), this.home.user.id);
                participants.delete(authorEmail.toLowerCase());

                // Pick recipients synchronously (populates activityNotifiedEmails for coveredEmails
                // below), then fan out the sends concurrently — notifyActivity already isolates failures.
                const recipientIds: string[] = [];
                for (const [email, userId] of participants) {
                    if (mentionedEmailSet.has(email)) continue;
                    if (!memberEmails.has(email)) continue;
                    activityNotifiedEmails.add(email);
                    recipientIds.push(userId);
                }
                await Promise.all(recipientIds.map((userId) => notifyActivity(userId)));
            }

            // File history: 'commented' on the container (or the standalone chat itself).
            // Whisper content is private to its recipient — never expose it via history.
            // Everyone the mention/activity notifications already covered is excluded
            // from the watcher fan-out so nobody is notified twice.
            if (type !== 'whisper') {
                const coveredEmails = new Set<string>([
                    authorEmail.toLowerCase(),
                    ...mentionedEmailSet,
                    ...activityNotifiedEmails,
                ]);
                await this.drive.recordFileEvent(
                    targetPath.mountId,
                    targetPath.id,
                    author,
                    { eventType: 'commented', details: { preview: content.slice(0, 80), chatName: this.path.name } },
                    { excludeEmails: coveredEmails },
                );
            }
        }

        return message;
    }

    private async getMessages(limit: number = 50, beforeId?: string): Promise<ChatMessage[]> {
        let rows: ChatMessage[];
        if (beforeId) {
            const beforeMsg = await this.db
                .select()
                .from(schema.messages)
                .where(eq(schema.messages.id, beforeId))
                .get();
            if (!beforeMsg) return [];
            rows = await this.db
                .select()
                .from(schema.messages)
                .where(lt(schema.messages.createdAt, beforeMsg.createdAt))
                .orderBy(desc(schema.messages.createdAt))
                .limit(limit)
                .all();
        } else {
            rows = await this.db
                .select()
                .from(schema.messages)
                .orderBy(desc(schema.messages.createdAt))
                .limit(limit)
                .all();
        }

        return rows.map((r) => this.toMessage(r)).reverse();
    }

    async getMessagesForUser(
        userId: string,
        userEmail: string,
        limit: number = 50,
        beforeId?: string,
    ): Promise<ChatMessage[]> {
        const allMessages = await this.getMessages(limit, beforeId);

        return allMessages.map((msg) => {
            if (msg.type === 'whisper') {
                const isAuthor = msg.authorId === userId;
                const isRecipient = msg.whisperTo === userId || msg.whisperTo === userEmail;
                const targetName = msg.whisperTo || 'someone';
                if (isAuthor) {
                    return { ...msg, content: `whispers to ${targetName}: ${msg.content}` };
                }
                if (isRecipient) {
                    return { ...msg, content: `whispers to you: ${msg.content}` };
                }
                return {
                    ...msg,
                    content: `whispers to ${targetName}: [a few hushed words]`,
                    whisperTo: null,
                    attachments: null,
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

    async editMessage(messageId: string, content: string, userId: string): Promise<ChatMessage> {
        const existing = await this.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!existing || existing.authorId !== userId) {
            throw new ApiError(404, 'Message not found or not owned');
        }

        const now = new Date();
        await this.db.update(schema.messages).set({ content, editedAt: now }).where(eq(schema.messages.id, messageId));

        const updated = this.toMessage({ ...existing, content, editedAt: now });

        const event = buildChatEvent(SSEventType.CHAT_MESSAGE_EDITED, {
            chatId: this.path.id,
            ownerId: this.path.ownerId,
            mountId: this.path.mountId,
        });
        this.home.broadcast(event);
        const members = await this.drive.getEffectiveMembers(this.path.mountId, this.path.id);
        this.notifySharedUsers(event, members);

        if (this.containerPath && existing.type !== 'whisper') {
            await this.updateCommentIndex(async (index) => {
                await index.updateActivity(this.path.name, existing.authorEmail, content, false);
                for (const email of extractMentionedEmails(content)) {
                    await index.addMention(this.path.name, email);
                }
            }, members);
        }

        return updated;
    }

    async deleteMessage(messageId: string, userId: string): Promise<void> {
        const existing = await this.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
        if (!existing || existing.authorId !== userId) {
            throw new ApiError(404, 'Message not found or not owned');
        }

        const now = new Date();
        await this.db
            .update(schema.messages)
            .set({ deletedAt: now, content: '' })
            .where(eq(schema.messages.id, messageId));

        if (existing.attachments) {
            // Attachment strings are file names in this chat's own media/ folder; resolve within it
            // so a crafted pathId can't trash arbitrary owner-writable paths elsewhere in the mount.
            const mediaFolder = await this.drive.getChildByName(this.path.mountId, this.path.id, 'media');
            if (mediaFolder) {
                for (const attachment of existing.attachments) {
                    if (typeof attachment !== 'string') continue;
                    const media = await this.drive.getChildByName(this.path.mountId, mediaFolder.id, attachment);
                    if (media) await this.drive.deletePath(this.path.mountId, media.id);
                }
            }
        }

        const event = buildChatEvent(SSEventType.CHAT_MESSAGE_DELETED, {
            chatId: this.path.id,
            ownerId: this.path.ownerId,
            mountId: this.path.mountId,
        });
        this.home.broadcast(event);
        const members = await this.drive.getEffectiveMembers(this.path.mountId, this.path.id);
        this.notifySharedUsers(event, members);

        if (this.containerPath && existing.type !== 'whisper') {
            await this.updateCommentIndex(async (index) => {
                await index.decrementCount(this.path.name);
            }, members);
        }
    }

    async markRead(userId: string, messageId: string): Promise<void> {
        const now = new Date();
        const existing = await this.db.select().from(schema.readState).where(eq(schema.readState.userId, userId)).get();
        if (existing) {
            await this.db
                .update(schema.readState)
                .set({ lastReadMessageId: messageId, lastReadAt: now })
                .where(eq(schema.readState.userId, userId));
        } else {
            await this.db.insert(schema.readState).values({
                userId,
                lastReadMessageId: messageId,
                lastReadAt: now,
            });
        }
    }

    private async updateCommentIndex(fn: (index: CommentIndex) => Promise<void>, members?: EffectiveMember[]) {
        if (!this.containerPath) return;
        try {
            const index = await openCommentIndex(this.drive, this.containerPath);
            await fn(index);
            await index.setRecentText(this.path.name, await this.buildRecentText());

            const event = buildCommentIndexUpdatedEvent(this.containerPath.id, this.path.ownerId, this.path.mountId);
            this.home.broadcast(event);
            this.notifySharedUsers(event, members);
        } catch (error) {
            console.error('Failed to update comment index:', error);
        }
    }

    // Newest-first tail of the live thread text, rebuilt in full on every indexed write (recompute,
    // not append — deleted messages leave the index, edits don't duplicate; threads are short).
    private async buildRecentText(): Promise<string> {
        const rows = await this.db
            .select({ content: schema.messages.content })
            .from(schema.messages)
            .where(
                and(
                    isNull(schema.messages.deletedAt),
                    ne(schema.messages.type, 'whisper'),
                    ne(schema.messages.content, ''),
                ),
            )
            .orderBy(desc(schema.messages.createdAt))
            // Empty messages are filtered out above, so every row adds at least one char and
            // RECENT_TEXT_CAP rows always fill the byte cap — bound the fetch instead of scanning the thread.
            .limit(RECENT_TEXT_CAP)
            .all();
        let text = '';
        for (const row of rows) {
            text = text ? `${text}\n${row.content}` : row.content;
            if (text.length >= RECENT_TEXT_CAP) break;
        }
        return text.slice(0, RECENT_TEXT_CAP);
    }

    // Uses getEffectiveMembers to resolve all users with access — handles inherited
    // ACL from parent folders, team membership, and container document ACL.
    // Pass pre-resolved members to avoid a redundant ACL walk when postMessage has already fetched them.
    private async notifySharedUsers(event: SSEvent, members?: EffectiveMember[]) {
        // Non-rejecting: every caller fires this without awaiting, so a relay/lookup failure must
        // never surface as an unhandled rejection or break the mutation that triggered it.
        try {
            const resolved = members ?? (await this.drive.getEffectiveMembers(this.path.mountId, this.path.id));
            await relayEventToMembers(resolved, event);
        } catch (error) {
            console.error('Failed to relay event to members:', error);
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
