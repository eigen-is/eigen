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
 * Extracts flags from a message filename
 * @param fileName Filename with flags (format: id:2,flags)
 * @returns Array of flags
 */
export function extractFlagsFromFileName(fileName: string): string[] {
    const flags: string[] = [];

    // Check if the filename has flags (format: id:2,flags)
    const flagsMatch = fileName.match(/:2,([A-Z]+)$/);
    if (flagsMatch && flagsMatch[1]) {
        // Convert each character to a flag
        const flagChars = flagsMatch[1].split('');

        // Map flag characters to IMAP flags
        for (const char of flagChars) {
            switch (char) {
                case 'S':
                    flags.push('\\Seen');
                    break;
                case 'R':
                    flags.push('\\Answered');
                    break;
                case 'F':
                    flags.push('\\Flagged');
                    break;
                case 'D':
                    flags.push('\\Draft');
                    break;
                case 'T':
                    flags.push('\\Deleted');
                    break;
                default:
                    // Unknown flag, add as is
                    flags.push(char);
            }
        }
    }

    return flags;
}

/**
 * Adds or removes a flag from a filename
 * @param fileName Original filename
 * @param flag Flag character to add or remove (S, R, F, D, T)
 * @param add True to add, false to remove
 * @returns Updated filename
 */
export function updateFlagInFileName(fileName: string, flag: string, add: boolean): string {
    // Map IMAP flags to characters
    const flagMap: Record<string, string> = {
        '\\Seen': 'S',
        '\\Answered': 'R',
        '\\Flagged': 'F',
        '\\Draft': 'D',
        '\\Deleted': 'T'
    };

    // Convert IMAP flag to character if needed
    const flagChar = flagMap[flag] || flag;

    // Check if the filename has flags
    const parts = fileName.split(':');
    const id = parts[0];

    if (parts.length < 2) {
        // No flags yet, add the flag section
        return add ? `${id}:2,${flagChar}` : id;
    }

    // Extract existing flags
    const flagSection = parts[1];
    const flagsMatch = flagSection.match(/^2,([A-Z]*)$/);

    if (!flagsMatch) {
        // Invalid flag format, return original
        return fileName;
    }

    let flags = flagsMatch[1].split('');

    if (add) {
        // Add flag if not already present
        if (!flags.includes(flagChar)) {
            flags.push(flagChar);
        }
    } else {
        // Remove flag if present
        flags = flags.filter(f => f !== flagChar);
    }

    // Sort flags alphabetically (standard practice)
    flags.sort();

    // Reconstruct the filename
    return `${id}:2,${flags.join('')}`;
}

/**
 * Converts a message filename to a new filename with updated flags
 * @param fileName Original filename
 * @param flags Array of IMAP flags
 * @returns Updated filename
 */
export function createFileNameWithFlags(fileName: string, flags: string[]): string {
    // Get the ID part of the filename
    const id = getMailIDfromFileName(fileName);

    // Convert IMAP flags to characters
    const flagChars: string[] = [];

    for (const flag of flags) {
        switch (flag) {
            case '\\Seen':
                flagChars.push('S');
                break;
            case '\\Answered':
                flagChars.push('R');
                break;
            case '\\Flagged':
                flagChars.push('F');
                break;
            case '\\Draft':
                flagChars.push('D');
                break;
            case '\\Deleted':
                flagChars.push('T');
                break;
            // Skip other flags that don't have a character representation
        }
    }

    // Sort flags alphabetically (standard practice)
    flagChars.sort();

    // Construct the new filename
    return flagChars.length > 0 ? `${id}:2,${flagChars.join('')}` : id;
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