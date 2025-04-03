import {type User} from "better-auth/types";
import {getUserByEmail} from "../users/users.ts";
import {getHome} from "../home/home.ts";

async function getMailClient(user: User) {
    const home = await getHome(user);
    return home.mail;
}

/**
 * Lists all mailboxes in the Maildir structure
 * @param user User object
 * @returns Array of mailbox objects with hierarchy information
 */
export async function mailboxesList(user: User) {
    const mail = await getMailClient(user);
    return await mail.mailboxesList();
}

/**
 * Gets information about a specific mailbox
 * @param user User object
 * @param mailbox Mailbox name
 * @returns Mailbox with messages or false if mailbox doesn't exist
 */
export async function mailboxGet(user: User, mailbox: string) {
    const mail = await getMailClient(user);
    return await mail.mailboxGet(mailbox);
}

/**
 * Creates a new mailbox
 * @param user User object
 * @param mailbox Mailbox name
 * @param attributes Optional IMAP attributes for the mailbox
 * @returns True if successful
 */
export async function mailboxCreate(user: User, mailbox: string, attributes: string[] = []) {
    const mail = await getMailClient(user);
    return await mail.mailboxCreate(mailbox, attributes);
}

/**
 * Checks if a mailbox exists
 * @param user User object
 * @param mailbox Mailbox name
 * @returns Mailbox object if exists, false otherwise
 */
export async function mailboxExists(user: User, mailbox: string) {
    const mail = await getMailClient(user);
    return await mail.mailboxExists(mailbox);
}

/**
 * Sets up a watch on a mailbox for changes
 * @param user User object
 * @param mailbox Mailbox name
 * @param callback Callback function for changes
 * @returns True if successful
 */
export async function mailboxWatch(user: User, mailbox: string, callback: (event: string, filename: string) => void) {
    const mail = await getMailClient(user);
    return await mail.mailboxWatch(mailbox, callback);
}

/**
 * Delivers a message to the INBOX
 * @param to Recipient email address
 * @param file file as binary ArrayBuffer
 * @returns Filename of the delivered message
 */
export async function mailboxDeliver(to: string, file: ArrayBuffer) {
    const user = await getUserByEmail(to);
    console.log('Delivering message to:', to, user, file);
    if (user) {
        const mail = await getMailClient(user);
        // convert file to string
        const message = new TextDecoder().decode(new Uint8Array(file));
        return await mail.mailboxDeliver(message);
    } else {
        return false;
    }
}

/**
 * Gets a specific message by ID
 * @param user User object
 * @param messageId Message ID
 * @returns Message or null if not found
 */
export async function messageGet(user: User, messageId: string) {
    const mail = await getMailClient(user);
    return await mail.messageGet(messageId);
}

/**
 * Deletes a message
 * @param user User object
 * @param messageId Message ID
 * @returns True if successful
 */
export async function messageDelete(user: User, messageId: string) {
    const mail = await getMailClient(user);
    return await mail.messageDelete(messageId);
}

/**
 * Moves a message to another mailbox
 * @param user User object
 * @param messageId Message ID
 * @param targetMailbox Target mailbox name
 * @returns True if successful
 */
export async function messageMove(user: User, messageId: string, targetMailbox: string) {
    const mail = await getMailClient(user);
    return await mail.messageMove(messageId, targetMailbox);
}

export async function messageMoveToInbox(user: User, messageId: string) {
    const mailboxes = await mailboxesList(user);
    const inbox = mailboxes.find(mailbox => mailbox.flags.includes('\\Inbox'));
    if (inbox) {
        return await messageMove(user, messageId, inbox.path);
    }
}

export async function messageMoveToArchive(user: User, messageId: string) {
    const mailboxes = await mailboxesList(user);
    const archive = mailboxes.find(mailbox => mailbox.flags.includes('\\Archive'));
    if (archive) {
        return await messageMove(user, messageId, archive.path);
    }
}

export async function messageMoveToSpam(user: User, messageId: string) {
    const mailboxes = await mailboxesList(user);
    const spam = mailboxes.find(mailbox => mailbox.flags.includes('\\Junk'));
    if (spam) {
        return await messageMove(user, messageId, spam.path);
    }
}

export async function messageMoveToTrash(user: User, messageId: string) {
    const mailboxes = await mailboxesList(user);
    const trash = mailboxes.find(mailbox => mailbox.flags.includes('\\Trash'));
    if (trash) {
        return await messageMove(user, messageId, trash.path);
    }
}

/**
 * Copies a message to another mailbox
 * @param user User object
 * @param messageId Message ID
 * @param targetMailbox Target mailbox name
 * @returns True if successful
 */
export async function messageCopy(user: User, messageId: string, targetMailbox: string) {
    const mail = await getMailClient(user);
    return await mail.messageCopy(messageId, targetMailbox);
}

/**
 * Updates a draft message
 * @param user User object
 * @param mail Draft message to update
 * @returns True if successful
 */
export async function messageHandleDraft(user: User, mail: any) {
    const mailClient = await getMailClient(user);
    return await mailClient.messageHandleDraft(mail);
}

/**
 * Sends a draft message
 * @param user User object
 * @param mail Draft message to send
 * @returns True if successful
 */
export async function messageSend(user: User, mail: any) {
    const mailClient = await getMailClient(user);
    return await mailClient.messageSend(mail);
}

/**
 * Sets the read status of a message
 * @param user User object
 * @param messageId Message ID
 * @param read True to mark as read, false to mark as unread
 * @returns True if successful
 */
export async function messageSetRead(user: User, messageId: string, read: boolean) {
    const mail = await getMailClient(user);
    return await mail.messageSetRead(messageId, read);
}

/**
 * Gets an attachment from a message
 * @param user User object
 * @param messageId Message ID
 * @param index Attachment index
 * @returns Attachment or null if not found
 */
export async function messageGetAttachment(user: User, messageId: string, index: number) {
    const mail = await getMailClient(user);
    return await mail.messageGetAttachment(messageId, index);
}