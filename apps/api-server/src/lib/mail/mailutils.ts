import Bun from 'bun';
import * as fs from "node:fs/promises";

export function getMailIDfromFileName(fileName: string): string {
    // Extract ID from filename (part before the colon)
    let fileId = fileName.split(':')[0];
    // Remove file extension (.eml)
    if (fileId.endsWith('.eml')) {
        fileId = fileId.substring(0, fileId.length - 4);
    }
    return fileId;
}

/**
 * Creates a new unique message ID
 * @returns Unique message ID
 */
export function createUniqueMessageId(): string {
    return `${Date.now()}.${crypto.randomUUID()}`;
}

/**
 * Determines if a mailbox is a special mailbox that shouldn't be renamed or deleted
 * @param attributes Array of mailbox attributes
 * @returns True if the mailbox is special
 */
export function isSpecialMailbox(attributes: string[]): boolean {
    const specialAttributes = ['\\Inbox', '\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\Archive'];
    return attributes.some(attr => specialAttributes.includes(attr));
}

/**
 * Gets the standard IMAP flags for a special mailbox
 * @param mailboxName Name of the mailbox
 * @returns Array of IMAP flags
 */
export function getStandardMailboxFlags(mailboxName: string): string[] {
    const name = mailboxName.toLowerCase();

    if (name === '' || name === 'inbox') {
        return ['\\HasNoChildren', '\\Inbox'];
    } else if (name === 'sent') {
        return ['\\HasNoChildren', '\\Sent'];
    } else if (name === 'drafts') {
        return ['\\HasNoChildren', '\\Drafts'];
    } else if (name === 'trash') {
        return ['\\HasNoChildren', '\\Trash'];
    } else if (name === 'junk' || name === 'spam') {
        return ['\\HasNoChildren', '\\Junk'];
    } else if (name === 'archive') {
        return ['\\HasNoChildren', '\\Archive'];
    } else {
        return ['\\HasNoChildren'];
    }
}

/**
 * Checks if a directory exists
 * @param path Path to the directory
 * @returns True if the directory exists
 */
export async function fsDirectoryExists(path: string): Promise<boolean> {
    try {
        await fs.access(path);
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Checks if a file exists
 * @param path Path to the file
 * @returns True if the file exists
 */
export async function fsFileExists(path: string): Promise<boolean> {
    return await Bun.file(path).exists();
}