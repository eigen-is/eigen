// Refactored IMAP implementation using Drizzle ORM
import { drizzle } from 'drizzle-orm/bun-sqlite';
import {eq, like, and, sql, InferModel} from 'drizzle-orm';
import Database from "bun:sqlite";
import { User } from "better-auth/types";
import { fsGetFileName } from "../fs/fs";

// Import schema definitions
import * as schema from './schema';
import {mailboxes} from "./schema";

/**
 * Minimal Drizzle-based IMAP-like mailbox handling in TypeScript.
 *
 * This implementation uses Drizzle ORM instead of raw SQL queries
 * for better type safety and query building.
 */

export type Mailbox = typeof mailboxes.$inferSelect;
export type MailMessage = typeof schema.messages.$inferSelect;

async function imap_db(user: User) {
    const file = await fsGetFileName(user, 'mailbox.db');
    const sqlite = new Database(file, {create: true});
    return drizzle(sqlite, { schema });
}

// -- 1) Initialize the mailboxes table ------------------------------------
export async function imap_init(user: User) {
    try {
        // Create tables if they don't exist
        const db = await imap_db(user);
        // Create tables based on schema definitions

        // Create tables based on schema definitions
        db.run(sql`
    CREATE TABLE IF NOT EXISTS mailboxes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        parent_id INTEGER NULL,
        subscribed INTEGER NOT NULL DEFAULT 0,
        attributes TEXT NOT NULL DEFAULT ''
    );
`);

        db.run(sql`
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mailbox_id INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        subject TEXT,
        sender TEXT,
        recipients TEXT,
        date_sent TEXT,
        date_received TEXT,
        raw_message TEXT,
        FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id)
    );
`);

        db.run(sql`
    CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        filename TEXT,
        content_type TEXT,
        data BLOB,
        FOREIGN KEY(message_id) REFERENCES messages(id)
    );
`);

        db.run(sql`
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
export async function imap_mailboxes_list(user: User, referenceName = "", mailboxPattern = "*") {
    try {
        const db = await imap_db(user);
        let mailboxes: Mailbox[] = [];
        
        if (mailboxPattern === "*") {
            // Get all mailboxes
            // mailboxes = await db.select().from(schema.mailboxes);

            const mailboxes = await db.select({
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


            const mailboxes = await db.select({
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
export async function imap_mailboxes_create(user: User, name: string) {
    try {
        const db = await imap_db(user);

        db.insert(schema.mailboxes).values({
            name,
            subscribed: 0,
            attributes: ''
        }).run();

        return {success: true, message: `Mailbox '${name}' created.`};
    } catch (error) {
        return {success: false, error: String(error)};
    }
}

async function imap_mailbox_exists(user: User, name: string) {
    try {
        const db = await imap_db(user);
        const mailbox = db.select()
            .from(schema.mailboxes)
            .where(eq(schema.mailboxes.name, name))
            .get();
            
        return mailbox || false;
    } catch (error) {
        return false;
    }
}

// -- 4) Rename a mailbox (IMAP 'RENAME') ----------------------------------
export async function imap_mailboxes_rename(user: User, oldName: string, newName: string) {
    try {
        const oldMailbox = await imap_mailbox_exists(user, oldName);
        if (!oldMailbox) {
            return {success: false, error: `Mailbox '${oldName}' not found.`};
        } else {
            const db = await imap_db(user);

            db.update(schema.mailboxes)
                .set({name: newName})
                .where(eq(schema.mailboxes.id, oldMailbox.id))
                .run();
        }

        return {success: true, message: `Mailbox '${oldName}' renamed to '${newName}'.`};
    } catch (error) {
        return {success: false, error: String(error)};
    }
}

// -- 5) Delete a mailbox (IMAP 'DELETE') ----------------------------------
export async function imap_mailboxes_delete(user: User, name: string) {
    try {
        const db = await imap_db(user);
        
        // Check if mailbox exists
        const mailbox = db.select()
            .from(schema.mailboxes)
            .where(eq(schema.mailboxes.name, name))
            .get();
            
        if (!mailbox) {
            return {success: false, error: `Mailbox '${name}' not found.`};
        }

        // Delete from table
        db.delete(schema.mailboxes)
            .where(eq(schema.mailboxes.id, mailbox.id));

        return {success: true, message: `Mailbox '${name}' deleted.`};
    } catch (error) {
        return {success: false, error: String(error)};
    }
}

// -- 6) Subscribe a mailbox (IMAP 'SUBSCRIBE') ----------------------------
export async function imap_mailboxes_subscribe(user: User, name: string) {
    try {
        const mailbox = await imap_mailbox_exists(user, name);
        if (!mailbox) {
            return {success: false, error: `Mailbox '${name}' not found.`};
        }

        const db = await imap_db(user);
        await db.update(schema.mailboxes)
            .set({ subscribed: 1 })
            .where(eq(schema.mailboxes.id, mailbox.id));

        return {success: true, message: `Mailbox '${name}' subscribed.`};
    } catch (error) {
        return {success: false, error: String(error)};
    }
}

// -- 7) Unsubscribe a mailbox (IMAP 'UNSUBSCRIBE') ------------------------
export async function imap_mailboxes_unsubscribe(user: User, name: string) {
    try {
        const mailbox = await imap_mailbox_exists(user, name);
        if (!mailbox) {
            return {success: false, error: `Mailbox '${name}' not found.`};
        }

        const db = await imap_db(user);
        await db.update(schema.mailboxes)
            .set({ subscribed: 0 })
            .where(eq(schema.mailboxes.id, mailbox.id));

        return {success: true, message: `Mailbox '${name}' unsubscribed.`};
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
export async function imap_messages_append(
    user: User,
    mailboxName: string,
    subject: string,
    sender: string,
    recipients: string,
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
        const db = await imap_db(user);

        // 1) Determine mailbox_id
        const mailbox = await imap_mailbox_exists(user, mailboxName);
        if (!mailbox) {
            return { success: false, error: `Mailbox '${mailboxName}' not found.` };
        }

        // 2) Insert into messages table
        const result =  db.insert(schema.messages)
            .values({
                mailbox_id: mailbox.id,
                subject,
                sender,
                recipients,
                date_sent: dateSent || null,
                date_received: new Date().toISOString(),
                raw_message: rawMessage
            })
            .returning({ insertedId: schema.messages.id })
            .get();
          
          const lastId = result.insertedId;

        // 4) Insert flags if provided
        if (flags && flags.length > 0) {
            for (const flag of flags) {
                await db.insert(schema.messageFlags)
                    .values({
                        message_id: lastId,
                        flag
                    });
            }
        }

        // 5) Insert attachments if provided
        if (attachments && attachments.length > 0) {
            for (const att of attachments) {
                await db.insert(schema.attachments)
                    .values({
                        message_id: lastId,
                        filename: att.filename,
                        content_type: att.contentType,
                        data: att.data
                    });
            }
        }

        return { success: true, message: "Message appended successfully.", messageId: lastId };
    } catch (error) {
        return { success: false, error: String(error) };
    }
}

// ------------------ Fetch messages (IMAP 'FETCH') ------------------ //

/**
 * imap_messages_fetch:
 *  Retrieves messages from a mailbox. Optionally filter by message ID or a simple condition.
 *  For a real IMAP-like system, you'd parse sequence sets, fetch flags, etc.
 */
export async function imap_messages_fetch(
    user: User,
    mailboxName: string,
    messageId?: number
) {
    try {
        const db = await imap_db(user);

        // 1) Get mailbox info
        const mailbox = await imap_mailbox_exists(user, mailboxName);
        if (!mailbox) {
            return { success: false, error: `Mailbox '${mailboxName}' not found.` };
        }

        // 2) If messageId is provided, limit the query to that message
        //    Otherwise, retrieve all messages in that mailbox
        let messages: MailMessage[];
        
        if (messageId) {
            messages = await db.select()
                .from(schema.messages)
                .where(
                    and(
                        eq(schema.messages.mailbox_id, mailbox.id),
                        eq(schema.messages.id, messageId)
                    )
                );
        } else {
            messages = await db.select()
                .from(schema.messages)
                .where(eq(schema.messages.mailbox_id, mailbox.id));
        }

        // 3) For each message, gather flags & attachments
        for (const msg of messages) {
            // Flags
            const flags = await db.select({ flag: schema.messageFlags.flag })
                .from(schema.messageFlags)
                .where(eq(schema.messageFlags.message_id, msg.id));
                
            // Attachments
            const attachments = await db.select()
                .from(schema.attachments)
                .where(eq(schema.attachments.message_id, msg.id));

            // Attach them to the message object
            (msg as any).flags = flags.map(f => f.flag);
            (msg as any).attachments = attachments;
        }

        return { success: true, messages };
    } catch (error) {
        return { success: false, error: String(error) };
    }
}

// ------------------ Store flags (IMAP 'STORE') ------------------ //

/**
 * imap_messages_store:
 *  Allows for updating flags by adding or removing them.
 *  Example usage: imap_messages_store(user, mailboxName, 123, ['\\Flagged'], '+');
 */
export async function imap_messages_store(
    user: User,
    mailboxName: string,
    messageId: number,
    flags: string[],
    mode: '+' | '-'
) {
    try {
        const db = await imap_db(user);

        // 1) Ensure mailbox & message exist
        const mailbox = await imap_mailbox_exists(user, mailboxName);
        if (!mailbox) {
            return { success: false, error: `Mailbox '${mailboxName}' not found.` };
        }

        const message = db.select()
            .from(schema.messages)
            .where(
                and(
                    eq(schema.messages.mailbox_id, mailbox.id),
                    eq(schema.messages.id, messageId)
                )
            )
            .get();
            
        if (!message) {
            return { success: false, error: `Message with id=${messageId} not found in '${mailboxName}'.` };
        }

        // 2) Insert or remove flags
        for (const flag of flags) {
            if (mode === '+') {
                // Check if flag exists
                const existingFlag =  db.select()
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
                    await db.insert(schema.messageFlags)
                        .values({
                            message_id: messageId,
                            flag
                        });
                }
            } else if (mode === '-') {
                // Remove flag
                await db.delete(schema.messageFlags)
                    .where(
                        and(
                            eq(schema.messageFlags.message_id, messageId),
                            eq(schema.messageFlags.flag, flag)
                        )
                    );
            }
        }

        return { success: true, message: `Flags updated for message ${messageId}.` };
    } catch (error) {
        return { success: false, error: String(error) };
    }
}

// ------------------ Delete a message (IMAP 'DELETE/EXPUNGE') ------------------ //

/**
 * imap_messages_delete:
 *  Physically removes the specified message from the database, along with its flags and attachments.
 *  IMAP in practice might only mark them as deleted, then EXPUNGE. But this is a direct remove.
 */
export async function imap_messages_delete(
    user: User,
    mailboxName: string,
    messageId: number
) {
    try {
        const db = await imap_db(user);

        // 1) Ensure mailbox & message exist
        const mailbox = await imap_mailbox_exists(user, mailboxName);
        if (!mailbox) {
            return { success: false, error: `Mailbox '${mailboxName}' not found.` };
        }

        // Check if message is in that mailbox
        const message =  db.select()
            .from(schema.messages)
            .where(
                and(
                    eq(schema.messages.mailbox_id, mailbox.id),
                    eq(schema.messages.id, messageId)
                )
            )
            .get();
            
        if (!message) {
            return { success: false, error: `Message ${messageId} not found in mailbox '${mailboxName}'.` };
        }

        // 2) Delete attachments
        await db.delete(schema.attachments)
            .where(eq(schema.attachments.message_id, messageId));

        // 3) Delete flags
        await db.delete(schema.messageFlags)
            .where(eq(schema.messageFlags.message_id, messageId));

        // 4) Delete message
        await db.delete(schema.messages)
            .where(eq(schema.messages.id, messageId));

        return { success: true, message: `Message ${messageId} deleted from '${mailboxName}'.` };
    } catch (error) {
        return { success: false, error: String(error) };
    }
}

// ------------------ Copy a message (IMAP 'COPY') ------------------ //

/**
 * imap_messages_copy:
 *  Copies a message from one mailbox to another, duplicating flags and attachments.
 *  If you want to copy multiple messages, you'd loop or adapt this function.
 */
export async function imap_messages_copy(
    user: User,
    sourceMailboxName: string,
    destinationMailboxName: string,
    messageId: number
) {
    try {
        const db = await imap_db(user);

        // 1) Check source/destination mailboxes
        const sourceMailbox = await imap_mailbox_exists(user, sourceMailboxName);
        const destinationMailbox = await imap_mailbox_exists(user, destinationMailboxName);
        if (!sourceMailbox) {
            return { success: false, error: `Source mailbox '${sourceMailboxName}' not found.` };
        }
        if (!destinationMailbox) {
            return { success: false, error: `Destination mailbox '${destinationMailboxName}' not found.` };
        }

        // 2) Get source message
        const message = db.select()
            .from(schema.messages)
            .where(
                and(
                    eq(schema.messages.mailbox_id, sourceMailbox.id),
                    eq(schema.messages.id, messageId)
                )
            )
            .get();
            
        if (!message) {
            return { success: false, error: `Message ${messageId} not found in mailbox '${sourceMailboxName}'.` };
        }

        // 3) Insert the message into destination mailbox
        const result = db.insert(schema.messages)
            .values({
                mailbox_id: destinationMailbox.id,
                subject: message.subject,
                sender: message.sender,
                recipients: message.recipients,
                date_sent: message.date_sent,
                date_received: message.date_received,
                raw_message: message.raw_message
            })
            .returning({ insertedId: schema.messages.id })
            .get();
          
          const newId = result.insertedId;

        // 4) Copy flags
        const flags = await db.select()
            .from(schema.messageFlags)
            .where(eq(schema.messageFlags.message_id, message.id));
            
        for (const flag of flags) {
            await db.insert(schema.messageFlags)
                .values({
                    message_id: newId,
                    flag: flag.flag
                });
        }

        // 5) Copy attachments
        const attachments = await db.select()
            .from(schema.attachments)
            .where(eq(schema.attachments.message_id, message.id));
            
        for (const att of attachments) {
            await db.insert(schema.attachments)
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
        return { success: false, error: String(error) };
    }
}