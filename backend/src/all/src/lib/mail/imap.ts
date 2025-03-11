// Assume we have a db object with a query API like this:
// const query = (await imap_db(user)).query("SELECT 'Hello world' as message;");
// query.get(); // => { message: "Hello world" }

// Below are some example functions in TypeScript to manage IMAP-like mailboxes in an SQLite database:
// - imap_init: creates the mailboxes table if it doesn't exist
// - imap_mailboxes_list: returns a list of mailboxes (with optional pattern matching)
// - imap_mailboxes_create: creates a new mailbox
// - imap_mailboxes_rename: renames a mailbox
// - imap_mailboxes_delete: deletes a mailbox
// - imap_mailboxes_subscribe: sets subscribed = 1
// - imap_mailboxes_unsubscribe: sets subscribed = 0

import Database from "bun:sqlite";
import imapCreateTable from "./imapCreateTable.txt";
import {User} from "better-auth/types";
import {fsGetFileName} from "../fs/fs";

/**
 * Minimal SQLite-based IMAP-like mailbox handling in TypeScript.
 *
 * Assumptions:
 * - 'db' is a global or higher scoped SQLite access object that uses:
 *   (await imap_db(user)).query(sqlString).get() // => retrieves a single row
 *   (await imap_db(user)).query(sqlString).all(params) // => retrieves multiple rows
 * - This code does not do full IMAP wildcard logic for mailboxPattern,
 *   but demonstrates a simple LIKE approach.
 * - Error handling is minimal; adapt for production usage.
 * - Attributes stored as a comma-separated string in 'attributes' column.
 */


/**
 * Minimal TypeScript-based IMAP-like message handling, using SQLite.
 *
 * Assumptions / Notes:
 *  - We have an async function imap_db(user: User) that returns an
 *    object with a .query(sql) method. The .query(...) returns an object
 *    with .get(params?) and .all(params?) methods for single/multiple rows.
 *  - We have a helper function imap_mailbox_exists(user, mailboxName)
 *    that returns the mailbox record (with .id, etc.) or null if not found.
 *  - We store flags in a separate 'message_flags' table and attachments
 *    in an 'attachments' table.
 *  - This code snippet focuses on the main operations for messages:
 *    init (table creation), append, fetch, store (flags), delete, copy,
 *    plus minimal attachments handling. Adapt as needed for production.
 */



// Example interface for mailbox record
interface Mailbox {
    id: number;
    name: string;
    parent_id?: number | null;
    subscribed: 0 | 1;
    attributes: string;
}

// Basic interface for a message record
interface MessageRecord {
    id: number;
    mailbox_id: number;
    subject: string;
    sender: string;
    recipients: string;
    date_sent: string;      // stored as ISO8601 string
    date_received: string;  // stored as ISO8601 string
    raw_message: string;
}


async function imap_db(user: User) {
    const file = await fsGetFileName(user, 'mailbox.db');
    return new Database(file, {create: true});
}

// -- 1) Initialize the mailboxes table ------------------------------------
export async function imap_init(user: User) {
    try {
        // Create a table if it does not exist already
        const createTableSQL = imapCreateTable.split(';');
        const db = await imap_db(user);
        for (const sql of createTableSQL) {
            const query = db.query(sql);
            query.get();
        }

        return {success: true, message: "Mailboxes table initialized successfully."};
    } catch (error) {
        return {success: false, error: String(error)};
    }
}

// -- 2) List mailboxes (approximate IMAP 'LIST') --------------------------
export async function imap_mailboxes_list(user: User, referenceName = "", mailboxPattern = "*") {
    try {
        // This is a naive approach for demonstration:
        // If mailboxPattern = '*', return all. Otherwise use LIKE on name.
        let mailboxes: Mailbox[] = [];
        if (mailboxPattern === "*") {
            const query = (await imap_db(user)).query(`SELECT * FROM mailboxes`);
            mailboxes = query.all() as Mailbox[];
        } else {
            const query = (await imap_db(user)).query(`SELECT * FROM mailboxes WHERE name LIKE $pattern`);
            mailboxes = query.all({$pattern: mailboxPattern.replace("*", "%")}) as Mailbox[];
        }

        return {success: true, mailboxes};
    } catch (error) {
        return {success: false, error: String(error)};
    }
}

// -- 3) Create a mailbox (IMAP 'CREATE') ----------------------------------
export async function imap_mailboxes_create(user: User, name: string) {
    try {
        // Optional: figure out parent_id from name if using a delimiter approach
        // e.g. if name = "prive/vrienden", parent might be "prive".
        // For now, do a very simplistic approach: no nesting logic.
        const query = (await imap_db(user)).query(`INSERT INTO mailboxes (name, subscribed, attributes) VALUES ($name, 0, '')`);
        query.get({$name: name});

        return {success: true, message: `Mailbox '${name}' created.`};
    } catch (error) {
        return {success: false, error: String(error)};
    }
}

async function imap_mailbox_exists(user: User, name: string) {
    try {
        const query = (await imap_db(user)).query(`SELECT * FROM mailboxes WHERE name = $name`);
        const mailbox = query.get({$name: name});
        return mailbox ? mailbox as Mailbox : false;
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
            // Update the mailbox name
            const updateQuery = (await imap_db(user)).query(`UPDATE mailboxes SET name = $newName WHERE id = $id`);
            updateQuery.get({$newName: newName, $id: oldMailbox.id});
        }
        // Optionally, if you want to also rename subfolders automatically
        // something like:
        // UPDATE mailboxes
        // SET name = REPLACE(name, $oldName || '/', $newName || '/')
        // WHERE name LIKE $pattern;

        return {success: true, message: `Mailbox '${oldName}' renamed to '${newName}'.`};
    } catch (error) {
        return {success: false, error: String(error)};
    }
}

// -- 5) Delete a mailbox (IMAP 'DELETE') ----------------------------------
export async function imap_mailboxes_delete(user: User, name: string) {
    try {
        // Check if mailbox exists
        const checkQuery = (await imap_db(user)).query(`SELECT * FROM mailboxes WHERE name = $name`);
        const mailbox = checkQuery.get({$name: name});
        if (!mailbox) {
            return {success: false, error: `Mailbox '${name}' not found.`};
        }

        // Delete from table
        const deleteQuery = (await imap_db(user)).query(`DELETE FROM mailboxes WHERE id = $id`);
        deleteQuery.get({$id: (mailbox as Mailbox).id});

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

        const updateQuery = (await imap_db(user)).query(`UPDATE mailboxes SET subscribed = 1 WHERE id = $id`);
        updateQuery.get({$id: mailbox.id});

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

        const updateQuery = (await imap_db(user)).query(`UPDATE mailboxes SET subscribed = 0 WHERE id = $id`);
        updateQuery.get({$id: mailbox.id});

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
        const insertQuery = db.query(`
      INSERT INTO messages 
      (mailbox_id, subject, sender, recipients, date_sent, date_received, raw_message)
      VALUES 
      ($mailboxId, $subject, $sender, $recipients, $dateSent, datetime('now'), $rawMessage)
    `);
        insertQuery.get({
            $mailboxId: mailbox.id,
            $subject: subject,
            $sender: sender,
            $recipients: recipients,
            $dateSent: dateSent || null,
            $rawMessage: rawMessage,
        });

        // 3) Retrieve newly inserted message ID
        //    (In SQLite, last_insert_rowid() is typical if we do separate calls)
        const lastIdQuery = db.query(`SELECT last_insert_rowid() as lastId`);
        const { lastId } = lastIdQuery.get() as { lastId: number };

        // 4) Insert flags if provided
        if (flags && flags.length > 0) {
            for (const flag of flags) {
                const fq = db.query(`
          INSERT INTO message_flags (message_id, flag)
          VALUES ($messageId, $flag)
        `);
                fq.get({ $messageId: lastId, $flag: flag });
            }
        }

        // 5) Insert attachments if provided
        if (attachments && attachments.length > 0) {
            for (const att of attachments) {
                const aq = db.query(`
          INSERT INTO attachments (message_id, filename, content_type, data)
          VALUES ($messageId, $filename, $contentType, $data)
        `);
                aq.get({
                    $messageId: lastId,
                    $filename: att.filename,
                    $contentType: att.contentType,
                    $data: att.data,
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
        let messagesQuery;
        if (messageId) {
            messagesQuery = db.query(`
        SELECT * FROM messages
        WHERE mailbox_id = $mailboxId AND id = $messageId
      `);
        } else {
            messagesQuery = db.query(`
        SELECT * FROM messages
        WHERE mailbox_id = $mailboxId
      `);
        }

        const messages = messagesQuery.all({
            $mailboxId: mailbox.id,
            $messageId: messageId || null,
        }) as MessageRecord[];

        // 3) For each message, gather flags & attachments
        for (const msg of messages) {
            // Flags
            const flagQ = db.query(`SELECT flag FROM message_flags WHERE message_id = $msgId`);
            const flagsRows = flagQ.all({ $msgId: msg.id }) as { flag: string }[];
            const flags = flagsRows.map((fr: { flag: string }) => fr.flag);

            // Attachments
            const attQ = db.query(`SELECT id, filename, content_type, data FROM attachments WHERE message_id = $msgId`);
            const attachments = attQ.all({ $msgId: msg.id });

            // Attach them to the message object
            (msg as any).flags = flags;
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

        const msgQuery = db.query(`
      SELECT id FROM messages WHERE mailbox_id = $mailboxId AND id = $messageId
    `);
        const msgRow = msgQuery.get({ $mailboxId: mailbox.id, $messageId: messageId });
        if (!msgRow) {
            return { success: false, error: `Message with id=${messageId} not found in '${mailboxName}'.` };
        }

        // 2) Insert or remove flags
        for (const flag of flags) {
            if (mode === '+') {
                // Add flag (if not exists)
                const checkFlagQ = db.query(`
          SELECT 1 FROM message_flags 
          WHERE message_id = $msgId AND flag = $flag
        `);
                const exists = checkFlagQ.get({ $msgId: messageId, $flag: flag });
                if (!exists) {
                    const insertFlagQ = db.query(`
            INSERT INTO message_flags (message_id, flag)
            VALUES ($msgId, $flag)
          `);
                    insertFlagQ.get({ $msgId: messageId, $flag: flag });
                }
            } else if (mode === '-') {
                // Remove flag
                const removeFlagQ = db.query(`
          DELETE FROM message_flags
          WHERE message_id = $msgId AND flag = $flag
        `);
                removeFlagQ.get({ $msgId: messageId, $flag: flag });
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
        const msgQuery = db.query(`SELECT id FROM messages WHERE mailbox_id = $mailboxId AND id = $messageId`);
        const msgRow = msgQuery.get({ $mailboxId: mailbox.id, $messageId: messageId }) as MessageRecord | null;
        if (!msgRow) {
            return { success: false, error: `Message ${messageId} not found in mailbox '${mailboxName}'.` };
        }

        // 2) Delete attachments
        let q = db.query(`DELETE FROM attachments  WHERE message_id = $messageId`);
        q.get({ $messageId: messageId });

        // 3) Delete flags
        q = db.query(`DELETE FROM message_flags WHERE message_id = $messageId`);
        q.get({ $messageId: messageId });

        // 4) Delete message
        q = db.query(`DELETE FROM messages WHERE id = $messageId`);
        q.get({ $messageId: messageId });

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
        const msgQ = db.query(`SELECT * FROM messages WHERE mailbox_id = $mailboxId AND id = $messageId`);
        const message = msgQ.get({
            $mailboxId: sourceMailbox.id,
            $messageId: messageId,
        }) as MessageRecord;
        if (!message) {
            return { success: false, error: `Message ${messageId} not found in mailbox '${sourceMailboxName}'.` };
        }

        // 3) Insert the message into destination mailbox
        const insertQ = db.query(`INSERT INTO messages
              (mailbox_id, subject, sender, recipients, date_sent, date_received, raw_message)
              VALUES
              ($mailboxId, $subject, $sender, $recipients, $dateSent, $dateReceived, $rawMessage)
            `);
        insertQ.get({
            $mailboxId: destinationMailbox.id,
            $subject: message.subject,
            $sender: message.sender,
            $recipients: message.recipients,
            $dateSent: message.date_sent,
            $dateReceived: message.date_received,
            $rawMessage: message.raw_message,
        });

        const newMsgIdQuery = db.query(`SELECT last_insert_rowid() as newId`) ;
        const { newId } = newMsgIdQuery.get() as { newId: number };

        // 4) Copy flags
        const flagsQ = db.query(`SELECT flag FROM message_flags WHERE message_id = $msgId`);
        const flags = flagsQ.all({ $msgId: message.id }) as { flag: string }[];
        for (const f of flags) {
            const insertFlagQ = db.query(`INSERT INTO message_flags (message_id, flag) VALUES ($messageId, $flag)`);
            insertFlagQ.get({ $messageId: newId, $flag: f.flag });
        }

        // 5) Copy attachments
        const attQ = db.query(`SELECT filename, content_type, data FROM attachments WHERE message_id = $msgId`);
        const attachments = attQ.all({ $msgId: message.id }) as { filename: string; content_type: string; data: Buffer }[];
        for (const att of attachments) {
            const attInsertQ = db.query(`INSERT INTO attachments (message_id, filename, content_type, data) VALUES ($messageId, $filename, $contentType, $data)`);
            attInsertQ.get({
                $messageId: newId,
                $filename: att.filename,
                $contentType: att.content_type,
                $data: att.data,
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