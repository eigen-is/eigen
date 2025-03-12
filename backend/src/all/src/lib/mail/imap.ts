// Refactored IMAP implementation using Drizzle ORM
import {BunSQLiteDatabase, drizzle} from 'drizzle-orm/bun-sqlite';
import {and, eq, like, sql} from 'drizzle-orm';
import Database from "bun:sqlite";
import {User} from "better-auth/types";
import {fsGetDatabase} from "../fs/fs";

// Import schema definitions
import * as schema from './schema';
import {mailboxes} from './schema';

export type Mailbox = typeof mailboxes.$inferSelect;
export type MailMessage = typeof schema.messages.$inferSelect;

class imap {
    private db!: BunSQLiteDatabase<typeof schema> & { $client: Database; };
    private user: User;

    constructor(user: User) {
        this.user = user;
    }

    public async login() {
        this.db = drizzle(await fsGetDatabase(this.user, 'mailbox.db'), {schema});
    }

    public async logout() {
        return true;
    }

    public async create_tables() {
        try {
            this.db.run(sql`
    CREATE TABLE IF NOT EXISTS mailboxes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        parent_id INTEGER NULL,
        subscribed INTEGER NOT NULL DEFAULT 0,
        attributes TEXT NOT NULL DEFAULT ''
    );
`);

            this.db.run(sql`
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mailbox_id INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        subject TEXT,
        from TEXT,
        to TEXT,
        cc TEXT,
        bcc TEXT,
        date_sent TEXT,
        date_received TEXT,
        raw_message TEXT,
        FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id)
    );
`);

            this.db.run(sql`
    CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        filename TEXT,
        content_type TEXT,
        data BLOB,
        FOREIGN KEY(message_id) REFERENCES messages(id)
    );
`);

            this.db.run(sql`
    CREATE TABLE IF NOT EXISTS message_flags (
        message_id INTEGER NOT NULL,
        flag TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(id)
    );
`);

            return {success: true, message: "Mailboxes table initialized successfully."};
        } catch (error) {
            return {success: false, error: String(error)};
        }
    }

// -- 2) List mailboxes (approximate IMAP 'LIST') --------------------------
    public async mailboxes_list(referenceName = "", mailboxPattern = "*") {
        try {
            if (mailboxPattern === "*") {
                // Get all mailboxes
                // mailboxes = await db.select().from(schema.mailboxes);

                const mailboxes = await this.db.select({
                    id: schema.mailboxes.id,
                    name: schema.mailboxes.name,
                    subscribed: schema.mailboxes.subscribed,
                    attributes: schema.mailboxes.attributes,
                    messageCount: sql`COUNT(${schema.messages.id})`.as('message_count'),
                    unreadCount: sql`SUM(CASE WHEN ${schema.messages.read} = 0 THEN 1 ELSE 0 END)`.as('unread_count'),
                })
                    .from(schema.mailboxes)
                    .leftJoin(schema.messages, eq(schema.mailboxes.id, schema.messages.mailbox_id))
                    .groupBy(schema.mailboxes.id);

                return {success: true, mailboxes};
            } else {
                // Use pattern matching
                const pattern = mailboxPattern.replace("*", "%");
                // const mailboxes = await db.select()
                //     .from(schema.mailboxes)
                //     .where(like(schema.mailboxes.name, pattern));


                const mailboxes = await this.db.select({
                    id: schema.mailboxes.id,
                    name: schema.mailboxes.name,
                    subscribed: schema.mailboxes.subscribed,
                    attributes: schema.mailboxes.attributes,
                    messageCount: sql`COUNT(${schema.messages.id})`.as('message_count'),
                    unreadCount: sql`SUM(CASE WHEN ${schema.messages.read} = 0 THEN 1 ELSE 0 END)`.as('unread_count'),
                })
                    .from(schema.mailboxes)
                    .where(like(schema.mailboxes.name, pattern))
                    .leftJoin(schema.messages, eq(schema.mailboxes.id, schema.messages.mailbox_id))
                    .groupBy(schema.mailboxes.id);

                return {success: true, mailboxes};
            }
        } catch (error) {
            return {success: false, error: String(error)};
        }
    }

// -- 3) Create a mailbox (IMAP 'CREATE') ----------------------------------
    public async mailboxes_create(name: string, attributes: string[] = []) {
        try {
            this.db.insert(schema.mailboxes).values({
                name,
                subscribed: 0,
                attributes: attributes.join(' ')
            }).run();

            return {success: true, message: `Mailbox '${name}' created.`};
        } catch (error) {
            return {success: false, error: String(error)};
        }
    }

    public async mailbox_exists(name: string): Promise<Mailbox | false> {
        try {
            const mailbox = this.db.select()
                .from(schema.mailboxes)
                .where(eq(schema.mailboxes.name, name))
                .get() as Mailbox;

            return mailbox || false;
        } catch (error) {
            return false;
        }
    }

// -- 4) Rename a mailbox (IMAP 'RENAME') ----------------------------------
    public async mailboxes_rename(oldName: string, newName: string) {
        try {
            const oldMailbox = await this.mailbox_exists(oldName);
            if (!oldMailbox) {
                return {success: false, error: `Mailbox '${oldName}' not found.`};
            } else {
                this.db.update(schema.mailboxes)
                    .set({
                        name: newName
                    })
                    .where(eq(schema.mailboxes.id, oldMailbox.id))
                    .run();
            }

            return {success: true, message: `Mailbox '${oldName}' renamed to '${newName}'.`};
        } catch (error) {
            return {success: false, error: String(error)};
        }
    }

// -- 5) Delete a mailbox (IMAP 'DELETE') ----------------------------------
    public async mailboxes_delete(name: string) {
        try {
            // Check if mailbox exists
            const mailbox = this.db.select()
                .from(schema.mailboxes)
                .where(eq(schema.mailboxes.name, name))
                .get();

            if (!mailbox) {
                return {success: false, error: `Mailbox '${name}' not found.`};
            }

            // Delete from table
            this.db.delete(schema.mailboxes)
                .where(eq(schema.mailboxes.id, mailbox.id));

            return {success: true, message: `Mailbox '${name}' deleted.`};
        } catch (error) {
            return {success: false, error: String(error)};
        }
    }

// -- 6) Subscribe a mailbox (IMAP 'SUBSCRIBE') ----------------------------
    public async mailboxes_subscribe(name: string) {
        try {
            const mailbox = await this.mailbox_exists(name);
            if (!mailbox) {
                return {success: false, error: `Mailbox '${name}' not found.`};
            }

            await this.db.update(schema.mailboxes)
                .set({subscribed: 1})
                .where(eq(schema.mailboxes.id, mailbox.id));

            return {success: true, message: `Mailbox '${name}' subscribed.`};
        } catch (error) {
            return {success: false, error: String(error)};
        }
    }

// -- 7) Unsubscribe a mailbox (IMAP 'UNSUBSCRIBE') ------------------------
    public async mailboxes_unsubscribe(name: string) {
        try {
            const mailbox = await this.mailbox_exists(name);
            if (!mailbox) {
                return {success: false, error: `Mailbox '${name}' not found.`};
            } else {
                await this.db.update(schema.mailboxes)
                    .set({subscribed: 0})
                    .where(eq(schema.mailboxes.id, mailbox.id));

                return {success: true, message: `Mailbox '${name}' unsubscribed.`};
            }
        } catch (error) {
            return {success: false, error: String(error)};
        }
    }

// ------------------ Append a message (IMAP 'APPEND') ------------------ //

    /**
     * imap_messages_append:
     *  Creates a new message in the specified mailbox, optionally with attachments.
     *  If flags are provided, we store them in message_flags.
     */
    public async messages_append(
        mailboxName: string,
        subject: string,
        from: string,
        to: string,
        cc: string,
        bcc: string,
        rawMessage: string,
        dateSent?: string,
        attachments?: {
            filename: string;
            contentType: string;
            data: Buffer;
        }[],
        flags?: string[]
    ) {
        try {
            // 1) Determine mailbox_id
            const mailbox = await this.mailbox_exists(mailboxName);
            if (!mailbox) {
                return {success: false, error: `Mailbox '${mailboxName}' not found.`};
            }

            // 2) Insert into messages table
            const result = this.db.insert(schema.messages)
                .values({
                    mailbox_id: mailbox.id,
                    subject,
                    from,
                    to,
                    cc,
                    bcc,
                    date_sent: dateSent || null,
                    date_received: new Date().toISOString(),
                    raw_message: rawMessage
                })
                .returning({insertedId: schema.messages.id})
                .get();

            const lastId = result.insertedId;

            // 4) Insert flags if provided
            if (flags && flags.length > 0) {
                for (const flag of flags) {
                    await this.db.insert(schema.messageFlags)
                        .values({
                            message_id: lastId,
                            flag
                        });
                }
            }

            // 5) Insert attachments if provided
            if (attachments && attachments.length > 0) {
                for (const att of attachments) {
                    await this.db.insert(schema.attachments)
                        .values({
                            message_id: lastId,
                            filename: att.filename,
                            content_type: att.contentType,
                            data: att.data
                        });
                }
            }

            return {success: true, message: "Message appended successfully.", messageId: lastId};
        } catch (error) {
            return {success: false, error: String(error)};
        }
    }

// ------------------ Fetch messages (IMAP 'FETCH') ------------------ //

    /**
     * imap_messages_fetch:
     *  Retrieves messages from a mailbox. Optionally filter by message ID or a simple condition.
     *  For a real IMAP-like system, you'd parse sequence sets, fetch flags, etc.
     */
    public async messages_fetch(
        mailboxName: string,
        messageId?: number
    ) {
        try {
            // 1) Get mailbox info
            const mailbox = await this.mailbox_exists(mailboxName);
            if (!mailbox) {
                return {success: false, error: `Mailbox '${mailboxName}' not found.`};
            }

            // 2) If messageId is provided, limit the query to that message
            //    Otherwise, retrieve all messages in that mailbox
            let messages: MailMessage[];

            if (messageId) {
                messages = await this.db.select()
                    .from(schema.messages)
                    .where(
                        and(
                            eq(schema.messages.mailbox_id, mailbox.id),
                            eq(schema.messages.id, messageId)
                        )
                    );
            } else {
                messages = await this.db.select()
                    .from(schema.messages)
                    .where(eq(schema.messages.mailbox_id, mailbox.id));
            }

            // 3) For each message, gather flags & attachments
            for (const msg of messages) {
                // Flags
                const flags = await this.db.select({flag: schema.messageFlags.flag})
                    .from(schema.messageFlags)
                    .where(eq(schema.messageFlags.message_id, msg.id));

                // Attachments
                const attachments = await this.db.select()
                    .from(schema.attachments)
                    .where(eq(schema.attachments.message_id, msg.id));

                // Attach them to the message object
                (msg as any).flags = flags.map(f => f.flag);
                (msg as any).attachments = attachments;
            }

            return {success: true, messages};
        } catch (error) {
            return {success: false, error: String(error)};
        }
    }

// ------------------ Store flags (IMAP 'STORE') ------------------ //

    /**
     * imap_messages_store:
     *  Allows for updating flags by adding or removing them.
     *  Example usage: imap_messages_store(user, mailboxName, 123, ['\\Flagged'], '+');
     */
    public async messages_store(
        mailboxName: string,
        messageId: number,
        flags: string[],
        mode: '+' | '-'
    ) {
        try {
            // 1) Ensure mailbox & message exist
            const mailbox = await this.mailbox_exists(mailboxName);
            if (!mailbox) {
                return {success: false, error: `Mailbox '${mailboxName}' not found.`};
            }

            const message = this.db.select()
                .from(schema.messages)
                .where(
                    and(
                        eq(schema.messages.mailbox_id, mailbox.id),
                        eq(schema.messages.id, messageId)
                    )
                )
                .get();

            if (!message) {
                return {success: false, error: `Message with id=${messageId} not found in '${mailboxName}'.`};
            }

            // 2) Insert or remove flags
            for (const flag of flags) {
                if (mode === '+') {
                    // Check if flag exists
                    const existingFlag = this.db.select()
                        .from(schema.messageFlags)
                        .where(
                            and(
                                eq(schema.messageFlags.message_id, messageId),
                                eq(schema.messageFlags.flag, flag)
                            )
                        )
                        .get();

                    // Add flag if it doesn't exist
                    if (!existingFlag) {
                        await this.db.insert(schema.messageFlags)
                            .values({
                                message_id: messageId,
                                flag
                            });
                    }
                } else if (mode === '-') {
                    // Remove flag
                    await this.db.delete(schema.messageFlags)
                        .where(
                            and(
                                eq(schema.messageFlags.message_id, messageId),
                                eq(schema.messageFlags.flag, flag)
                            )
                        );
                }
            }

            return {success: true, message: `Flags updated for message ${messageId}.`};
        } catch (error) {
            return {success: false, error: String(error)};
        }
    }

// ------------------ Delete a message (IMAP 'DELETE/EXPUNGE') ------------------ //

    /**
     * imap_messages_delete:
     *  Physically removes the specified message from the database, along with its flags and attachments.
     *  IMAP in practice might only mark them as deleted, then EXPUNGE. But this is a direct remove.
     */
    public async messages_delete(
        mailboxName: string,
        messageId: number
    ) {
        try {
            // 1) Ensure mailbox & message exist
            const mailbox = await this.mailbox_exists(mailboxName);
            if (!mailbox) {
                return {success: false, error: `Mailbox '${mailboxName}' not found.`};
            }

            // Check if message is in that mailbox
            const message = this.db.select()
                .from(schema.messages)
                .where(
                    and(
                        eq(schema.messages.mailbox_id, mailbox.id),
                        eq(schema.messages.id, messageId)
                    )
                )
                .get();

            if (!message) {
                return {success: false, error: `Message ${messageId} not found in mailbox '${mailboxName}'.`};
            }

            // 2) Delete attachments
            await this.db.delete(schema.attachments)
                .where(eq(schema.attachments.message_id, messageId));

            // 3) Delete flags
            await this.db.delete(schema.messageFlags)
                .where(eq(schema.messageFlags.message_id, messageId));

            // 4) Delete message
            await this.db.delete(schema.messages)
                .where(eq(schema.messages.id, messageId));

            return {success: true, message: `Message ${messageId} deleted from '${mailboxName}'.`};
        } catch (error) {
            return {success: false, error: String(error)};
        }
    }

    public async messages_move(
        sourceMailboxName: string,
        destinationMailboxName: string,
        messageId: number
    ) {
        // 1) Check source/destination mailboxes
        const sourceMailbox = await this.mailbox_exists(sourceMailboxName);
        const destinationMailbox = await this.mailbox_exists(destinationMailboxName);
        if (!sourceMailbox) {
            return {success: false, error: `Source mailbox '${sourceMailboxName}' not found.`};
        }
        if (!destinationMailbox) {
            return {success: false, error: `Destination mailbox '${destinationMailboxName}' not found.`};
        }

        // update message mailbox_id
        this.db.update(schema.messages)
            .set({mailbox_id: destinationMailbox.id})
            .where(eq(schema.messages.id, messageId))
            .run();

        return {success: true, message: `Message ${messageId} moved from '${sourceMailboxName}' to '${destinationMailboxName}'.`};
    }


// ------------------ Copy a message (IMAP 'COPY') ------------------ //

    /**
     * imap_messages_copy:
     *  Copies a message from one mailbox to another, duplicating flags and attachments.
     *  If you want to copy multiple messages, you'd loop or adapt this function.
     */
    public async messages_copy(
        sourceMailboxName: string,
        destinationMailboxName: string,
        messageId: number
    ) {
        try {
            // 1) Check source/destination mailboxes
            const sourceMailbox = await this.mailbox_exists(sourceMailboxName);
            const destinationMailbox = await this.mailbox_exists(destinationMailboxName);
            if (!sourceMailbox) {
                return {success: false, error: `Source mailbox '${sourceMailboxName}' not found.`};
            }
            if (!destinationMailbox) {
                return {success: false, error: `Destination mailbox '${destinationMailboxName}' not found.`};
            }

            // 2) Get source message
            const message = this.db.select()
                .from(schema.messages)
                .where(
                    and(
                        eq(schema.messages.mailbox_id, sourceMailbox.id),
                        eq(schema.messages.id, messageId)
                    )
                )
                .get();

            if (!message) {
                return {success: false, error: `Message ${messageId} not found in mailbox '${sourceMailboxName}'.`};
            }

            // 3) Insert the message into destination mailbox
            const result = this.db.insert(schema.messages)
                .values({
                    mailbox_id: destinationMailbox.id,
                    subject: message.subject,
                    to: message.to,
                    from: message.from,
                    cc: message.cc,
                    bcc: message.bcc,
                    date_sent: message.date_sent,
                    date_received: message.date_received,
                    raw_message: message.raw_message
                })
                .returning({insertedId: schema.messages.id})
                .get();

            const newId = result.insertedId;

            // 4) Copy flags
            const flags = await this.db.select()
                .from(schema.messageFlags)
                .where(eq(schema.messageFlags.message_id, message.id));

            for (const flag of flags) {
                await this.db.insert(schema.messageFlags)
                    .values({
                        message_id: newId,
                        flag: flag.flag
                    });
            }

            // 5) Copy attachments
            const attachments = await this.db.select()
                .from(schema.attachments)
                .where(eq(schema.attachments.message_id, message.id));

            for (const att of attachments) {
                await this.db.insert(schema.attachments)
                    .values({
                        message_id: newId,
                        filename: att.filename,
                        content_type: att.content_type,
                        data: att.data
                    });
            }

            return {
                success: true,
                message: `Message ${messageId} copied from '${sourceMailboxName}' to '${destinationMailboxName}'.`,
                newMessageId: newId,
            };
        } catch (error) {
            return {success: false, error: String(error)};
        }
    }
}

export default imap;