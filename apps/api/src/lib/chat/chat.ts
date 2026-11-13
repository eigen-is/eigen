// One chat room: a .eigenchat file in Drive, which is a standalone chat or a comment thread inside a
// document. Drive opens a room for each chat request. The room stores, edits and deletes messages, and
// keeps a comment thread's row in the document's comment index up to date. After a post it notifies
// the people mentioned, the earlier participants and the file's watchers.

import { chatActivityTag, chatMentionTag } from '@workspace/lib/notification/tags';
import type { ChatAttachment, ChatMessage } from '@workspace/lib/types/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import type { NotificationPersistInput } from '@workspace/lib/types/notification';
import type { SSEventChat } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { validateEmailAddress } from '@workspace/lib/validation';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { ApiError } from '../core/errors';
import type { Drive } from '../drive';
import type { Home } from '../home';
import { broadcastToOwnerAndMembers, sendToUserHomes } from '../home/home-relay';
import type { Mount } from '../mount';
import { CONTAINER_DATA_DB, CONTAINER_MEDIA_FOLDER } from '../mount/container-dbs';
import type { User } from '../user';
import { getUserByEmail } from '../user';
import { formatEmoteForViewer, parseCommand, searchableMessageText } from './commands';
import type { CommentIndex } from './comment-index';
import { RECENT_TEXT_CAP, withCommentIndex } from './comment-index';
import { CHAT_ROOM_DB_CONFIG } from './db-config';
import { extractMentionedEmails } from './mentions';
import * as schema from './schema';
import { broadcastCommentIndexUpdated, buildChatEvent } from './sse-events';

export class ChatRoom {
    private constructor(
        private readonly drive: Drive,
        private readonly home: Home,
        public readonly path: DrivePath,
        private readonly dataDbId: string,
        // The document a comment thread belongs to. A chat on its own has none.
        public readonly containerPath: DrivePath | null,
    ) {}

    public static async create(drive: Drive, mount: Mount, roomId: string): Promise<void> {
        // The databases are set up in one step that cleans up after itself. A storage failure then leaves
        // no data.db row without a database, which would make every later init answer 503.
        await drive.provisionManagedDbs(mount.id, roomId, [{ name: CONTAINER_DATA_DB, config: CHAT_ROOM_DB_CONFIG }]);
        await mount.createFolder(roomId, CONTAINER_MEDIA_FOLDER);
    }

    // Finds the room's data.db. It opens nothing: each method below opens data.db for its own queries.
    public static async open(drive: Drive, home: Home, path: DrivePath): Promise<ChatRoom> {
        const dataDb = await drive.getChildByName(path.mountId, path.id, CONTAINER_DATA_DB);
        // A copy makes the room before it copies data.db into it. A request in between gets a 503 and
        // tries again, the same as a collab document.
        if (!dataDb) throw new ApiError(503, `${path.name} has no data.db yet`);
        const containerPath = await drive.findContainerPath(path.mountId, path.parentId ?? '');
        return new ChatRoom(drive, home, path, dataDb.id, containerPath);
    }

    public async postMessage(
        author: User,
        content: string,
        type: ChatMessage['type'] = 'message',
        whisperTo?: string,
        replyTo?: string,
        attachments?: ChatAttachment[],
    ): Promise<ChatMessage> {
        const { email: authorEmail } = author;
        if (content.startsWith('/') && type === 'message') {
            const command = parseCommand(content);
            switch (command.kind) {
                case 'builtin-emote':
                    type = 'emote';
                    content = command.target ? `$${command.emoteKey}:${command.target}` : `$${command.emoteKey}`;
                    break;
                case 'emote':
                    type = 'emote';
                    content = command.content;
                    break;
                case 'whisper':
                    type = 'whisper';
                    whisperTo = command.target;
                    content = command.content;
                    break;
                case 'error':
                    throw new ApiError(400, command.error);
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

        const id = crypto.randomUUID();
        const now = new Date();
        const attachmentData = attachments && attachments.length > 0 ? attachments : null;

        // The participants are read in the same call, so a post opens data.db once.
        const participantRows = await this.withDb(async (db) => {
            await db.insert(schema.messages).values({
                id,
                authorEmail,
                type,
                content,
                attachments: attachmentData,
                whisperTo: whisperTo ?? null,
                replyTo: replyTo ?? null,
                createdAt: now,
            });
            if (type !== 'message' && type !== 'emote') return [];
            return db
                .selectDistinct({ authorEmail: schema.messages.authorEmail })
                .from(schema.messages)
                .where(isNull(schema.messages.deletedAt))
                .all();
        });

        const message: ChatMessage = {
            id,
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

        // Each getEffectiveMembers walks the whole chain of ACLs and teams. So the members are read once
        // here, and the event, the comment index and the notifications below all use them.
        const members = await this.drive.getEffectiveMembers(this.path.mountId, this.path.id);

        // A system message notifies nobody, and its event reaches only the owner's tabs. No route can post
        // one, so no other tab misses such an event.
        this.broadcastMessageEvent(SSEventType.CHAT_MESSAGE_POSTED, type === 'system' ? [] : members);

        // A comment thread inside a document keeps the document's comment index up to date.
        if (type !== 'whisper') {
            await this.updateCommentIndex(async (index) => {
                await index.ensureComment(this.path.name, authorEmail);
                await index.updateActivity(this.path.name, authorEmail);
                for (const email of extractMentionedEmails(content)) {
                    await index.addMention(this.path.name, email);
                }
            }, members);
        }

        if (type !== 'system') {
            const displayName = stripEigenExtension(this.containerPath?.name ?? this.path.name);
            const targetPath = this.containerPath ?? this.path;
            // An embedded chat notifies about the container, naming the comment thread inside it.
            const thread = {
                ownerId: targetPath.ownerId,
                mountId: targetPath.mountId,
                pathId: targetPath.id,
                chatName: this.containerPath ? this.path.name : undefined,
            };
            const body = content.length > 100 ? `${content.slice(0, 100)}...` : content;
            const memberEmails = new Set(members.map((member) => member.email.toLowerCase()));

            // The deliveries open each recipient's home, so they run after the post answers.
            const notify = (userIds: string[], notification: NotificationPersistInput) => {
                sendToUserHomes(userIds, { type: 'notification', notification });
            };
            // The message is stored already, so a failed lookup costs only that person's notification.
            // It is logged, and the post still answers.
            const findUser = (email: string) =>
                getUserByEmail(email).catch((error: unknown) => {
                    console.error(`Failed to look up ${email} for a chat notification:`, error);
                    return null;
                });

            // A mentioned member hears about the message once, as a mention. So the activity
            // notifications below skip everyone in this set.
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
                        const mentionedUser = await findUser(email);
                        if (!mentionedUser) return;
                        // Each mention carries its own tag, so each one is its own delivery.
                        notify(
                            [mentionedUser.id],
                            this.containerPath
                                ? {
                                      type: 'mention-comment',
                                      actorEmail: authorEmail,
                                      title: mentionTitle,
                                      body,
                                      tag: chatMentionTag(thread, email),
                                      details: { pathType: this.containerPath.type },
                                  }
                                : {
                                      type: 'mention-chat',
                                      actorEmail: authorEmail,
                                      title: mentionTitle,
                                      body,
                                      tag: chatMentionTag(thread, email),
                                  },
                        );
                    }),
                );
            }

            // A whisper notifies its recipient only. A message or an emote notifies the earlier
            // participants and the owner.
            const activityNotifiedEmails = new Set<string>();
            const activity: NotificationPersistInput = this.containerPath
                ? {
                      type: 'comment-reply',
                      actorEmail: authorEmail,
                      title: `${author.name} commented on "${displayName}"`,
                      body,
                      tag: chatActivityTag(thread),
                      details: { pathType: this.containerPath.type },
                  }
                : {
                      type: 'chat-message',
                      actorEmail: authorEmail,
                      title: `New message from ${author.name} in "${displayName}"`,
                      body,
                      tag: chatActivityTag(thread),
                  };

            if (type === 'whisper' && whisperTo) {
                if (
                    whisperTo.toLowerCase() !== authorEmail.toLowerCase() &&
                    memberEmails.has(whisperTo.toLowerCase())
                ) {
                    const recipientUser = await findUser(whisperTo);
                    if (recipientUser) notify([recipientUser.id], activity);
                }
            } else if (type === 'message' || type === 'emote') {
                const participantEmails = new Set<string>(participantRows.map((row) => row.authorEmail.toLowerCase()));
                participantEmails.add(this.home.user.email.toLowerCase());
                participantEmails.delete(authorEmail.toLowerCase());

                // A room stores emails, not user ids, so each participant is looked up by email, and an
                // email without an account is skipped. The watcher fan-out below skips everyone found.
                const participants = await Promise.all(
                    [...participantEmails].map(async (email) => {
                        if (mentionedEmailSet.has(email)) return null;
                        if (!memberEmails.has(email)) return null;
                        const participant = await findUser(email);
                        if (!participant) return null;
                        activityNotifiedEmails.add(email);
                        return participant.id;
                    }),
                );
                notify(
                    participants.filter((id) => id !== null),
                    activity,
                );
            }

            // A whisper is private to its recipient, so it never reaches the history. The watchers skip everyone the
            // notifications above reached, so nobody hears of one message twice.
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

    public async getMessagesForUser(userEmail: string, limit = 50, beforeId?: string): Promise<ChatMessage[]> {
        const rows = await this.withDb(async (db) => {
            const before = beforeId
                ? await db
                      .select({ createdAt: schema.messages.createdAt, rowid: sql<number>`rowid` })
                      .from(schema.messages)
                      .where(eq(schema.messages.id, beforeId))
                      .get()
                : undefined;
            if (beforeId && !before) return [];
            return db
                .select()
                .from(schema.messages)
                .where(before && schema.olderThan(before))
                .orderBy(...schema.NEWEST_FIRST)
                .limit(limit)
                .all();
        });

        const viewerEmail = userEmail.toLowerCase();
        return rows.reverse().map((row) => {
            if (row.type === 'whisper') {
                const isAuthor = row.authorEmail.toLowerCase() === viewerEmail;
                const isRecipient = row.whisperTo?.toLowerCase() === viewerEmail;
                const targetName = row.whisperTo || 'someone';
                if (isAuthor) {
                    return { ...row, content: `whispers to ${targetName}: ${row.content}` };
                }
                if (isRecipient) {
                    return { ...row, content: `whispers to you: ${row.content}` };
                }
                return {
                    ...row,
                    content: `whispers to ${targetName}: [a few hushed words]`,
                    whisperTo: null,
                    attachments: null,
                };
            }
            if (row.type === 'emote' && !row.deletedAt) {
                return {
                    ...row,
                    content: formatEmoteForViewer(row.content, row.authorEmail, userEmail),
                };
            }
            return row;
        });
    }

    public async editMessage(messageId: string, content: string, userEmail: string): Promise<ChatMessage> {
        const now = new Date();
        const existing = await this.withDb(async (db) => {
            const existing = await db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
            if (!existing || existing.authorEmail.toLowerCase() !== userEmail.toLowerCase()) {
                throw new ApiError(404, 'Message not found or not owned');
            }
            await db.update(schema.messages).set({ content, editedAt: now }).where(eq(schema.messages.id, messageId));
            return existing;
        });

        const updated = { ...existing, content, editedAt: now };

        const members = await this.drive.getEffectiveMembers(this.path.mountId, this.path.id);
        this.broadcastMessageEvent(SSEventType.CHAT_MESSAGE_EDITED, members);

        if (existing.type !== 'whisper') {
            await this.updateCommentIndex(async (index) => {
                await index.updateActivity(this.path.name, existing.authorEmail, false);
                for (const email of extractMentionedEmails(content)) {
                    await index.addMention(this.path.name, email);
                }
            }, members);
        }

        return updated;
    }

    public async deleteMessage(messageId: string, userEmail: string): Promise<void> {
        const existing = await this.withDb(async (db) => {
            const existing = await db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
            if (!existing || existing.authorEmail.toLowerCase() !== userEmail.toLowerCase()) {
                throw new ApiError(404, 'Message not found or not owned');
            }
            await db
                .update(schema.messages)
                .set({ deletedAt: new Date(), content: '' })
                .where(eq(schema.messages.id, messageId));
            return existing;
        });

        if (existing.attachments) {
            // An attachment is a file name in this chat's own media folder. It is looked up only there, so a
            // crafted name can't delete another path of the owner's. It goes for good, like the message.
            const { mount } = await this.drive.resolveFile(this.path.mountId, this.path.id);
            const mediaFolder = await mount.getChildByName(this.path.id, CONTAINER_MEDIA_FOLDER);
            if (mediaFolder) {
                for (const attachment of existing.attachments) {
                    if (typeof attachment !== 'string') continue;
                    const media = await mount.getChildByName(mediaFolder.id, attachment);
                    if (media) await mount.deletePath(media.id);
                }
            }
        }

        const members = await this.drive.getEffectiveMembers(this.path.mountId, this.path.id);
        this.broadcastMessageEvent(SSEventType.CHAT_MESSAGE_DELETED, members);

        if (existing.type !== 'whisper') {
            await this.updateCommentIndex((index) => index.decrementCount(this.path.name), members);
        }
    }

    // Sends the event to the tabs of the owner and of everyone with access, through the folders above, a
    // team or the document's ACL. Nobody waits for it, so a failure is logged and never breaks the change.
    private broadcastMessageEvent(type: SSEventChat['type'], members: EffectiveMember[]): void {
        const event = buildChatEvent(type, {
            chatId: this.path.id,
            ownerId: this.path.ownerId,
            mountId: this.path.mountId,
        });
        broadcastToOwnerAndMembers(this.path.ownerId, members, event).catch((error: unknown) => {
            console.error('Failed to broadcast a chat event:', error);
        });
    }

    // Runs every query of one call on data.db, held open for just that long. The callers read all
    // they need inside fn, so nothing in fn waits on another lock or opens data.db a second time.
    private async withDb<T>(fn: (db: BunSQLiteDatabase<typeof schema>) => Promise<T>): Promise<T> {
        return this.drive.withDatabase(this.path.mountId, CHAT_ROOM_DB_CONFIG, this.dataDbId, (managed) =>
            fn(managed.db),
        );
    }

    // Applies fn to the thread's row in the document's comment index, and writes the thread's newest
    // text. A chat on its own has no index.
    private async updateCommentIndex(
        fn: (index: CommentIndex) => Promise<void>,
        members: EffectiveMember[],
    ): Promise<void> {
        if (!this.containerPath) return;
        try {
            await withCommentIndex(this.drive, this.containerPath.mountId, this.containerPath.id, async (index) => {
                await fn(index);
                // The text is read again right before it is written. Of two posts at once, the one that
                // writes last then also writes the text that holds both.
                const recentText = await this.withDb(buildRecentText);
                await index.setRecentText(this.path.name, recentText);
            });

            // Nobody waits for it, the same as for the message event.
            broadcastCommentIndexUpdated(
                this.drive,
                this.path.ownerId,
                this.path.mountId,
                this.containerPath.id,
                members,
            ).catch((error: unknown) => console.error('Failed to broadcast the comment index:', error));
        } catch (error) {
            console.error('Failed to update comment index:', error);
        }
    }
}

// The newest text of the thread, newest first, for the comment index. It is built again in full on
// every write, so a deleted message leaves it and an edit never shows twice. Threads are short.
async function buildRecentText(db: BunSQLiteDatabase<typeof schema>): Promise<string> {
    const rows = await db
        .select({
            type: schema.messages.type,
            content: schema.messages.content,
            authorEmail: schema.messages.authorEmail,
        })
        .from(schema.messages)
        .where(and(schema.SEARCHABLE_MESSAGES, ne(schema.messages.content, '')))
        .orderBy(...schema.NEWEST_FIRST)
        // Every row adds at least one character, because empty messages are left out above. So this
        // many rows always fill the cap, and the query needn't read the whole thread.
        .limit(RECENT_TEXT_CAP)
        .all();
    let text = '';
    for (const row of rows) {
        const content = await searchableMessageText(row);
        text = text ? `${text}\n${content}` : content;
        if (text.length >= RECENT_TEXT_CAP) break;
    }
    return text.slice(0, RECENT_TEXT_CAP);
}
