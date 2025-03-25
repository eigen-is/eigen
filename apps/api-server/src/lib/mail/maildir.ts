import type {User} from "better-auth";
import type { Mailbox } from "./imap";
import type { Email, Attachment } from "./mailtypes";
import { simpleParser } from "./mailtypes";
import {v4 as uuidv4} from "uuid";
import * as path from "path";
import * as fs from "node:fs/promises";
import { watch } from "node:fs";
import { createELMContent } from "./mailfile";
import { fsGetDirName } from "../fs/fs";
import Bun from 'bun';
import { 
    getMailIDfromFileName, 
    extractFlagsFromFileName, 
    updateFlagInFileName, 
    createFileNameWithFlags 
} from "./mailutils";

// Define a custom interface that extends Mailbox for our implementation
interface MaildirMailbox extends Omit<Mailbox, 'id'> {
    path: string;
    name: string;
    delimiter: string;
    flags: string[];
    total: number;
    unread: number;
    subscribed: boolean;
}

export default class Maildir {
    private basePath: string;
    private subscriptions: Set<string> = new Set();

    constructor(user: User) {
        this.basePath = fsGetDirName(user, 'eigen.mail/Maildir');
    }

    public async init() {
        // check if basePath exists
        try {
            await fs.access(this.basePath, fs.constants.F_OK);
            return;
        } catch (error) {
            await this.createMailboxes();
        }
    }

    private async createMailboxes() {
        // create Maildir - TODO: set correct attributes
        await fs.mkdir(this.basePath, { recursive: true });
        
        // Create INBOX (root mailbox)
        await this.mailboxCreate(``, ['\\HasNoChildren', '\\Inbox']);
        
        // Create special mailboxes with standard IMAP attributes
        await this.mailboxCreate(`Sent`, ['\\HasNoChildren', '\\Sent']);
        await this.mailboxCreate(`Drafts`, ['\\HasNoChildren', '\\Drafts']);
        await this.mailboxCreate(`Archive`, ['\\HasNoChildren', '\\Archive']);
        await this.mailboxCreate(`Spam`, ['\\HasNoChildren', '\\Junk']);
        await this.mailboxCreate(`Trash`, ['\\HasNoChildren', '\\Trash']);
    }

    /**
     * Lists all mailboxes in the Maildir structure
     * @returns Array of mailbox objects with hierarchy information
     */
    public async mailboxesList(): Promise<MaildirMailbox[]> {
        try {
            const mailboxes: MaildirMailbox[] = [];
            
            // Get the root directory (INBOX)
            const rootMailbox = await this.getMailboxInfo('');
            if (rootMailbox) {
                // Make sure the root mailbox is properly identified as INBOX
                rootMailbox.name = 'INBOX';
                rootMailbox.path = '';
                // Ensure INBOX has the proper flag
                if (!rootMailbox.flags.includes('\\Inbox')) {
                    rootMailbox.flags.push('\\Inbox');
                }
                mailboxes.push(rootMailbox);
            }
            
            // Get all directories in the base path
            const entries = await fs.readdir(this.basePath, { withFileTypes: true });
            
            for (const entry of entries) {
                // Only process directories that start with a dot (nested mailboxes)
                if (entry.isDirectory() && entry.name.startsWith('.')) {
                    // Skip special directories
                    if (['new', 'cur', 'tmp'].includes(entry.name)) {
                        continue;
                    }
                    
                    const mailboxName = entry.name.substring(1); // Remove the leading dot
                    const mailbox = await this.getMailboxInfo(mailboxName);
                    
                    if (mailbox) {
                        mailboxes.push(mailbox);
                        
                        // Process nested mailboxes (e.g., .prive.family)
                        await this.processNestedMailboxes(mailboxName, mailboxes);
                    }
                }
            }
            
            return mailboxes;
        } catch (error) {
            console.error('Error listing mailboxes:', error);
            return [];
        }
    }
    
    /**
     * Recursively processes nested mailboxes
     * @param parentPath Parent mailbox path
     * @param mailboxes Array to store found mailboxes
     */
    private async processNestedMailboxes(parentPath: string, mailboxes: MaildirMailbox[]) {
        try {
            // Get all entries in the parent directory
            const parentFullPath = path.join(this.basePath, `.${parentPath}`);
            const entries = await fs.readdir(parentFullPath);
            
            // Check each entry to see if it's a directory
            for (const entry of entries) {
                const entryPath = path.join(parentFullPath, entry);
                const stats = await fs.stat(entryPath);
                
                if (stats.isDirectory() && entry.startsWith('.')) {
                    // This is a nested mailbox
                    const nestedName = `${parentPath}.${entry.substring(1)}`;
                    const mailbox = await this.getMailboxInfo(nestedName);
                    
                    if (mailbox) {
                        mailboxes.push(mailbox);
                        // Recursively check for more nested mailboxes
                        await this.processNestedMailboxes(nestedName, mailboxes);
                    }
                }
            }
        } catch (error) {
            console.error(`Error processing nested mailboxes for ${parentPath}:`, error);
        }
    }
    
    /**
     * Gets information about a specific mailbox
     * @param mailboxName Name of the mailbox
     * @returns Mailbox object with information or null if not found
     */
    private async getMailboxInfo(mailboxName: string): Promise<MaildirMailbox | null> {
        try {
            const mailboxPath = mailboxName ? 
                await this.sanitizeDirName(mailboxName) : 
                this.basePath;
            
            // Check if mailbox exists
            try {
                await fs.access(mailboxPath, fs.constants.F_OK);
            } catch (error) {
                // Directory doesn't exist
                return null;
            }
            
            // Check for cur and new directories
            const curPath = path.join(mailboxPath, 'cur');
            const newPath = path.join(mailboxPath, 'new');
            
            try {
                await fs.access(curPath, fs.constants.F_OK);
                await fs.access(newPath, fs.constants.F_OK);
            } catch (error) {
                // Not a valid Maildir structure
                return null;
            }
            
            // Count messages in cur directory
            let curFiles: string[] = [];
            try {
                curFiles = await fs.readdir(curPath);
            } catch (error) {
                // Ignore errors
            }
            
            // Count messages in new directory (unread)
            let newFiles: string[] = [];
            try {
                newFiles = await fs.readdir(newPath);
            } catch (error) {
                // Ignore errors
            }
            
            // Get mailbox attributes
            const attributes = await this.getMailboxAttributes(mailboxName);
            
            // For the root mailbox (INBOX), ensure it has the \Inbox flag
            if (!mailboxName && !attributes.includes('\\Inbox')) {
                attributes.push('\\Inbox');
            }
            
            // Determine if this mailbox is subscribed
            const isSubscribed = this.subscriptions.has(mailboxName);
            
            // Create the mailbox object
            const mailbox: MaildirMailbox = {
                path: mailboxName,
                name: mailboxName ? mailboxName.split('.').pop() || mailboxName : 'INBOX',
                delimiter: '.',
                flags: attributes, // Use the attributes as flags
                total: curFiles.length + newFiles.length,
                unread: newFiles.length,
                subscribed: isSubscribed
            };
            
            return mailbox;
        } catch (error) {
            console.error(`Error getting mailbox info for ${mailboxName}:`, error);
            return null;
        }
    }

    /**
     * Sanitizes directory names for mailbox paths
     * @param mailbox Mailbox name
     * @param sub Optional subdirectory
     * @returns Sanitized directory path
     */
    private async sanitizeDirName(mailbox: string, sub: string = '') {
        let dirname = `${this.basePath}/.${mailbox.replace('/', '.')}`;
        // replace .. with . and // with /
        dirname = dirname.replace(/\.{2,}/g, '.');
        dirname = dirname.replace(/\/+/g, '/');
        return sub ? `${dirname}/${sub}` : dirname;
    }

    /**
     * Creates a new mailbox
     * @param mailbox Mailbox name
     * @param attributes Optional IMAP attributes for the mailbox
     * @returns True if successful
     */
    public async mailboxCreate(mailbox: string, attributes: string[] = []): Promise<boolean> {
        try {
            // Check if mailbox already exists
            const exists = await this.mailboxExists(mailbox);
            if (exists) {
                console.error(`Cannot create: mailbox ${mailbox} already exists`);
                return false;
            }
            
            // Create the mailbox directory structure
            const mailboxPath = await this.sanitizeDirName(mailbox);
            await fs.mkdir(mailboxPath, { recursive: true });
            
            // Create the cur, new, and tmp subdirectories
            await fs.mkdir(path.join(mailboxPath, 'cur'), { recursive: true });
            await fs.mkdir(path.join(mailboxPath, 'new'), { recursive: true });
            await fs.mkdir(path.join(mailboxPath, 'tmp'), { recursive: true });
            
            // Store attributes if provided
            if (attributes.length > 0) {
                const attributesPath = await this.sanitizeDirName(mailbox, '.attributes');
                await Bun.write(attributesPath, JSON.stringify(attributes));
            }
            
            return true;
        } catch (error) {
            console.error(`Error creating mailbox ${mailbox}:`, error);
            return false;
        }
    }

    /**
     * Checks if a mailbox exists
     * @param mailbox Mailbox name
     * @returns Mailbox object if exists, false otherwise
     */
    public async mailboxExists(mailbox: string): Promise<MaildirMailbox | false> {
        try {
            const mailboxInfo = await this.getMailboxInfo(mailbox);
            return mailboxInfo || false;
        } catch (error) {
            console.error(`Error checking if mailbox ${mailbox} exists:`, error);
            return false;
        }
    }

    /**
     * Renames a mailbox
     * @param oldName Old mailbox name
     * @param newName New mailbox name
     * @returns True if successful
     */
    public async mailboxRename(oldName: string, newName: string): Promise<boolean> {
        try {
            // Check if source mailbox exists
            const oldMailbox = await this.mailboxExists(oldName);
            if (!oldMailbox) {
                console.error(`Cannot rename: mailbox ${oldName} does not exist`);
                return false;
            }
            
            // Check if target mailbox already exists
            const newMailbox = await this.mailboxExists(newName);
            if (newMailbox) {
                console.error(`Cannot rename: mailbox ${newName} already exists`);
                return false;
            }
            
            // Check if this is a special mailbox that shouldn't be renamed
            const attributes = await this.getMailboxAttributes(oldName);
            const specialAttributes = ['\\Inbox', '\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\Archive'];
            if (attributes.some(attr => specialAttributes.includes(attr))) {
                console.error(`Cannot rename: ${oldName} is a special mailbox that cannot be renamed`);
                return false;
            }
            
            // Rename the mailbox
            const oldPath = await this.sanitizeDirName(oldName);
            const newPath = await this.sanitizeDirName(newName);
            await fs.rename(oldPath, newPath);
            
            return true;
        } catch (error) {
            console.error(`Error renaming mailbox ${oldName} to ${newName}:`, error);
            return false;
        }
    }

    /**
     * Deletes a mailbox
     * @param mailbox Mailbox name
     * @returns True if successful
     */
    public async mailboxDelete(mailbox: string): Promise<boolean> {
        try {
            // Check if mailbox exists
            const mailboxInfo = await this.mailboxExists(mailbox);
            if (!mailboxInfo) {
                console.error(`Cannot delete: mailbox ${mailbox} does not exist`);
                return false;
            }
            
            // Check if this is a special mailbox that shouldn't be deleted
            const attributes = await this.getMailboxAttributes(mailbox);
            const specialAttributes = ['\\Inbox', '\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\Archive'];
            if (attributes.some(attr => specialAttributes.includes(attr))) {
                console.error(`Cannot delete: ${mailbox} is a special mailbox that cannot be deleted`);
                return false;
            }
            
            // Delete the mailbox directory
            const mailboxPath = await this.sanitizeDirName(mailbox);
            await fs.rm(mailboxPath, { recursive: true, force: true });
            
            return true;
        } catch (error) {
            console.error(`Error deleting mailbox ${mailbox}:`, error);
            return false;
        }
    }

    /**
     * Subscribes to a mailbox
     * @param mailbox Mailbox name
     * @returns True if successful
     */
    public async mailboxSubscribe(mailbox: string): Promise<boolean> {
        try {
            // Check if mailbox exists
            const exists = await this.mailboxExists(mailbox);
            if (!exists) {
                console.error(`Cannot subscribe: mailbox ${mailbox} does not exist`);
                return false;
            }
            
            this.subscriptions.add(mailbox || 'INBOX');
            return true;
        } catch (error) {
            console.error(`Error subscribing to mailbox ${mailbox}:`, error);
            return false;
        }
    }

    /**
     * Unsubscribes from a mailbox
     * @param mailbox Mailbox name
     * @returns True if successful
     */
    public async mailboxUnsubscribe(mailbox: string): Promise<boolean> {
        try {
            if (this.subscriptions.has(mailbox || 'INBOX')) {
                this.subscriptions.delete(mailbox || 'INBOX');
                return true;
            }
            
            return false;
        } catch (error) {
            console.error(`Error unsubscribing from mailbox ${mailbox}:`, error);
            return false;
        }
    }

    public async mailboxWatch($mailbox: string, $callback: (event: string, filename: string) => void)  { 
        try {
            // Check if mailbox exists
            const mailboxInfo = await this.mailboxExists($mailbox);
            if (!mailboxInfo) {
                console.error(`Cannot watch: mailbox ${$mailbox} does not exist`);
                return false;
            }
            
            // Watch the new directory for changes
            const newPath = await this.sanitizeDirName($mailbox, 'new');
            
            // Using Node.js fs.watch instead of Bun.watch which is not available
            const watcher = watch(newPath, (eventType, filename) => {
                if (filename) {
                    $callback(eventType, filename);
                }
            });
            
            return true;
        } catch (error) {
            console.error(`Error watching mailbox ${$mailbox}:`, error);
            return false;
        }
    }

    public async mailboxDeliver($message: string) {
        try {
            // Create unique filename
            const filename = `${Date.now()}.${uuidv4()}.eml`;
            // Write message to file in the INBOX/new directory
            const newPath = path.join(this.basePath, 'new');
            await Bun.write(path.join(newPath, filename), $message);
            return filename;
        } catch (error) {
            console.error('Error delivering message:', error);
            throw error;
        }
    }

    /**
     * Gets all messages in a mailbox
     * @param mailbox Mailbox name
     * @returns Array of messages or false if mailbox doesn't exist
     */
    public async mailboxGet(mailbox: string): Promise<Email[] | false> {
        try {
            const mailboxPath = await this.sanitizeDirName(mailbox);
            
            // Check if mailbox exists
            try {
                await fs.access(mailboxPath, fs.constants.F_OK);
            } catch (error) {
                console.error(`Cannot get messages: mailbox ${mailbox} does not exist`);
                return false;
            }
            
            const newPath = path.join(mailboxPath, 'new');
            const curPath = path.join(mailboxPath, 'cur');
            
            const messages: Email[] = [];
            
            // Get messages from new directory (unread)
            try {
                await fs.access(newPath, fs.constants.F_OK);
                const newFiles = await fs.readdir(newPath);
                for (const fileName of newFiles) {
                    const message = await this.parseMessage(fileName, path.join(newPath, fileName), true, mailboxPath);
                    if (message) {
                        messages.push(message);
                    }
                }
            } catch (error) {
                // New directory doesn't exist
            }
            
            // Get messages from cur directory (read)
            try {
                await fs.access(curPath, fs.constants.F_OK);
                const curFiles = await fs.readdir(curPath);
                for (const fileName of curFiles) {
                    const message = await this.parseMessage(fileName, path.join(curPath, fileName), false, mailboxPath);
                    if (message) {
                        messages.push(message);
                    }
                }
            } catch (error) {
                // Cur directory doesn't exist
            }
            
            return messages;
        } catch (error) {
            console.error(`Error getting messages from mailbox ${mailbox}:`, error);
            return false;
        }
    }
    
    /**
     * Extracts flags from a message filename
     * @param filename Filename with flags (format: id:2,flags)
     * @returns Array of flags
     */
    private extractFlags(filename: string): string[] {
        return extractFlagsFromFileName(filename);
    }

    /**
     * Parse a message file and extract its contents
     * @param fileName Filename of the message
     * @param filePath Full path to the message file
     * @param isUnread Whether the message is unread (in 'new' directory)
     * @param mailboxPath Path to the mailbox containing the message
     * @returns Parsed email message or null if parsing failed
     */
    private async parseMessage(fileName: string, filePath: string, isUnread: boolean, mailboxPath: string): Promise<Email | null> {
        try {
            // Extract the message ID from the filename (part before the colon)
            // First remove the file extension if present
            let messageId = fileName;
            
            // Remove file extension (.eml)
            if (messageId.endsWith('.eml')) {
                messageId = messageId.substring(0, messageId.length - 4);
            }
            
            // Split by colon to get the ID part
            messageId = getMailIDfromFileName(messageId);
            
            // Parse the email content using Bun for file reading (faster)
            const fileContent = await Bun.file(filePath).text();
            const parsedMail = await simpleParser(fileContent);
            
            // Extract flags from the filename
            const flags = this.extractFlags(fileName);
            
            // If the message is in the new directory, it's unread
            if (isUnread) {
                flags.push('\\Recent');
            } else {
                flags.push('\\Seen');
            }
            
            // Create the Email object with the correct ID and path information
            const message: Email = {
                ...parsedMail,
                id: messageId,
                _path: mailboxPath,
                _filename: fileName,
                flags: flags,
                isRead: !isUnread
            };
            
            return message;
        } catch (error) {
            console.error(`Error parsing message ${fileName}:`, error);
            return null;
        }
    }

    /**
     * Gets a specific message by ID
     * @param messageId Message ID
     * @returns Message or null if not found
     */
    public async messageGet(messageId: string): Promise<Email | null> {
        try {
            // Try to find the message in all mailboxes
            const mailboxes = await this.mailboxesList();
            
            for (const mailbox of mailboxes) {
                const messages = await this.mailboxGet(mailbox.path);
                
                if (messages) {
                    const message = messages.find(msg => {
                        // Extract ID from filename using the utility function
                        const fileId = getMailIDfromFileName(msg._filename);
                        return fileId === messageId;
                    });
                    
                    if (message) {
                        return message;
                    }
                }
            }
            
            return null;
        } catch (error) {
            console.error(`Error getting message ${messageId}:`, error);
            return null;
        }
    }

    /**
     * Deletes a message
     * @param messageId Message ID
     * @returns True if successful
     */
    public async messageDelete(messageId: string): Promise<boolean> {
        try {
            // Find the message
            const message = await this.messageGet(messageId);
            if (!message) {
                console.error(`Cannot delete: message ${messageId} not found`);
                return false;
            }
            
            // Delete the file
            const filePath = path.join(message._path, message._filename);
            
            try {
                await fs.access(filePath, fs.constants.F_OK);
                await fs.unlink(filePath);
                return true;
            } catch (error) {
                console.error(`Cannot delete: file for message ${messageId} not found`);
                return false;
            }
        } catch (error) {
            console.error(`Error deleting message ${messageId}:`, error);
            return false;
        }
    }

    /**
     * Sets or unsets a flag on a message
     * @param messageId Message ID
     * @param flag Flag to set or unset
     * @param value True to set, false to unset
     * @returns True if successful
     */
    public async messageFlag(messageId: string, flag: string, value: boolean): Promise<boolean> {
        try {
            // Find the message
            const message = await this.messageGet(messageId);
            if (!message || !message._path || !message._filename) {
                console.error(`Cannot set flag: message ${messageId} not found`);
                return false;
            }
            
            // Map IMAP flag to Maildir flag
            let mailDirFlag = '';
            switch (flag.toUpperCase()) {
                case '\\SEEN': mailDirFlag = 'S'; break;
                case '\\ANSWERED': mailDirFlag = 'R'; break;
                case '\\FLAGGED': mailDirFlag = 'F'; break;
                case '\\DELETED': mailDirFlag = 'T'; break;
                case '\\DRAFT': mailDirFlag = 'D'; break;
                default:
                    console.error(`Unsupported flag: ${flag}`);
                    return false;
            }
            
            // Parse current flags
            const newFileName = updateFlagInFileName(message._filename, mailDirFlag, value);
            
            // Rename the file
            const oldPath = path.join(message._path, message._filename);
            const newPath = path.join(message._path, newFileName);
            
            try {
                await fs.access(oldPath, fs.constants.F_OK);
                await fs.rename(oldPath, newPath);
            } catch (error) {
                console.error(`Cannot rename: file for message ${messageId} not found`);
                return false;
            }
            
            // If setting \Seen flag, move from new to cur if needed
            if (flag.toUpperCase() === '\\SEEN' && value && message._path.endsWith('/new')) {
                const curPath = message._path.replace(/\/new$/, '/cur');
                await fs.rename(newPath, path.join(curPath, newFileName));
            }
            
            return true;
        } catch (error) {
            console.error(`Error setting flag ${flag} to ${value} for message ${messageId}:`, error);
            return false;
        }
    }

    /**
     * Moves a message to another mailbox
     * @param messageId Message ID
     * @param targetMailbox Target mailbox name
     * @returns True if successful
     */
    public async messageMove(messageId: string, targetMailbox: string): Promise<boolean> {
        try {
            // Find the message
            const message = await this.messageGet(messageId);
            if (!message || !message._path || !message._filename) {
                console.error(`Cannot move: message ${messageId} not found`);
                return false;
            }
            
            // Check if target mailbox exists
            const targetMailboxInfo = await this.mailboxExists(targetMailbox);
            if (!targetMailboxInfo) {
                console.error(`Cannot move: target mailbox ${targetMailbox} does not exist`);
                return false;
            }
            
            // Determine source and target directories
            const sourceDir = path.basename(message._path); // 'new' or 'cur'
            const targetPath = await this.sanitizeDirName(targetMailbox, sourceDir);
            
            // Move the file
            const sourcePath = path.join(message._path, message._filename);
            const targetFilePath = path.join(targetPath, message._filename);
            
            try {
                await fs.access(sourcePath, fs.constants.F_OK);
                // Read the file content using Bun (faster)
                const content = await Bun.file(sourcePath).text();
                
                // Write to the target location using Bun (faster)
                await Bun.write(targetFilePath, content);
                
                // Delete the source file
                await fs.unlink(sourcePath);
                
                return true;
            } catch (error) {
                console.error(`Cannot move: file for message ${messageId} not found`);
                return false;
            }
        } catch (error) {
            console.error(`Error moving message ${messageId} to mailbox ${targetMailbox}:`, error);
            return false;
        }
    }

    /**
     * Copies a message to another mailbox
     * @param messageId Message ID
     * @param targetMailbox Target mailbox name
     * @returns True if successful
     */
    public async messageCopy(messageId: string, targetMailbox: string): Promise<boolean> {
        try {
            // Find the message
            const message = await this.messageGet(messageId);
            if (!message || !message._path || !message._filename) {
                console.error(`Cannot copy: message ${messageId} not found`);
                return false;
            }
            
            // Check if target mailbox exists
            const targetMailboxInfo = await this.mailboxExists(targetMailbox);
            if (!targetMailboxInfo) {
                console.error(`Cannot copy: target mailbox ${targetMailbox} does not exist`);
                return false;
            }
            
            // Determine source and target directories
            const sourceDir = path.basename(message._path); // 'new' or 'cur'
            const targetPath = await this.sanitizeDirName(targetMailbox, sourceDir);
            
            // Copy the file
            const sourcePath = path.join(message._path, message._filename);
            const targetFilePath = path.join(targetPath, message._filename);
            
            try {
                await fs.access(sourcePath, fs.constants.F_OK);
                // Read the file content using Bun (faster)
                const content = await Bun.file(sourcePath).text();
                
                // Write to the target location using Bun (faster)
                await Bun.write(targetFilePath, content);
                
                return true;
            } catch (error) {
                console.error(`Cannot copy: file for message ${messageId} not found`);
                return false;
            }
        } catch (error) {
            console.error(`Error copying message ${messageId} to mailbox ${targetMailbox}:`, error);
            return false;
        }
    }

    /**
     * Creates a new draft message
     * @returns New draft message
     */
    public async messageCreateDraft(): Promise<Email> {
        try {
            // Check if Drafts mailbox exists
            const draftsMailbox = await this.mailboxExists('Drafts');
            if (!draftsMailbox) {
                // Create Drafts mailbox if it doesn't exist
                await this.mailboxCreate('Drafts', ['\\HasNoChildren', '\\Drafts']);
            }

            // Create a unique message ID
            const messageId = `${Date.now()}.${uuidv4()}`;
            const draftPath = await this.sanitizeDirName('Drafts', 'cur');
            const filename = createFileNameWithFlags(messageId, ['D']); // D flag for draft
            const filePath = path.join(draftPath, filename);
            
            // Create an empty message template with all required properties
            const emptyMessage = createELMContent({
                id: messageId,
                subject: '',
                from: { address: '' },
                to: { address: '' },
                date: new Date(),
                text: '',
                html: '',
                textAsHtml: '',
                attachments: [],
                headers: new Map(),
                references: [],
                messageId: `<${messageId}@eigen.local>`,
                inReplyTo: null,
                isRead: true,
                flags: ['\\Draft', '\\Seen'], // Standard IMAP flags for drafts
                _path: draftPath,
                _filename: filename
            });
            
            // Use Bun.write for file content operations (faster)
            await Bun.write(filePath, emptyMessage);
            
            // Get the newly created message
            const message = await this.messageGet(messageId);
            if (!message) {
                throw new Error(`Failed to create draft message: ${messageId}`);
            }
            
            return message;
        } catch (error) {
            console.error('Error creating draft message:', error);
            throw error;
        }
    }

    /**
     * Updates a draft message
     * @param mail Draft message to update
     * @returns True if successful
     */
    public async messageUpdateDraft(mail: Email): Promise<boolean> {
        try {
            // Check if this is actually a draft
            if (!mail.flags.includes('\\Draft')) {
                console.error('Cannot update: message is not a draft');
                return false;
            }
            
            // Make sure the draft is in the Drafts mailbox
            const draftsPath = await this.sanitizeDirName('Drafts');
            if (!mail._path.startsWith(draftsPath)) {
                console.error('Cannot update: draft is not in the Drafts mailbox');
                return false;
            }
            
            // Update the draft file
            const filePath = path.join(mail._path, mail._filename);
            
            try {
                await fs.access(filePath, fs.constants.F_OK);
                
                // Make sure the draft has the correct flags
                if (!mail.flags.includes('\\Seen')) {
                    mail.flags.push('\\Seen'); // Drafts should be marked as seen
                }
                
                // Ensure the Draft flag is present
                if (!mail.flags.includes('\\Draft')) {
                    mail.flags.push('\\Draft');
                }
                
                // Construct email content
                const content = createELMContent(mail);

                // Update the draft file using Bun.write (faster)
                await Bun.write(filePath, content);
                
                return true;
            } catch (error) {
                console.error('Cannot update: draft file does not exist');
                return false;
            }
        } catch (error) {
            console.error('Error updating draft message:', error);
            return false;
        }
    }

    /**
     * Sets the read status of a message
     * @param messageId Message ID
     * @param read True to mark as read, false to mark as unread
     * @returns True if successful
     */
    public async messageSetRead(messageId: string, read: boolean): Promise<boolean> {
        try {
            // Find the message
            const message = await this.messageGet(messageId);
            if (!message) {
                console.error(`Cannot set read status: message ${messageId} not found`);
                return false;
            }
            
            // Update the flag
            return await this.messageFlag(messageId, '\\Seen', read);
        } catch (error) {
            console.error(`Error setting read status for message ${messageId}:`, error);
            return false;
        }
    }

    /**
     * Gets an attachment from a message
     * @param messageId Message ID
     * @param index Attachment index
     * @returns Attachment or null if not found
     */
    public async messageGetAttachment(messageId: string, index: number): Promise<Attachment | null> {
        try {
            // Find the message
            const message = await this.messageGet(messageId);
            if (!message) {
                console.error(`Cannot get attachment: message ${messageId} not found`);
                return null;
            }
            
            // Check if attachment exists
            if (!message.attachments || index >= message.attachments.length) {
                console.error(`Attachment index ${index} out of bounds for message ${messageId}`);
                return null;
            }
            
            return message.attachments[index];
        } catch (error) {
            console.error(`Error getting attachment ${index} from message ${messageId}:`, error);
            return null;
        }
    }

    /**
     * Get mailbox attributes
     * @param mailbox Mailbox name
     * @returns Array of IMAP attributes
     */
    private async getMailboxAttributes(mailbox: string): Promise<string[]> {
        try {
            const attributesPath = await this.sanitizeDirName(mailbox, '.attributes');
            
            try {
                await fs.access(attributesPath, fs.constants.F_OK);
                const content = await Bun.file(attributesPath).text();
                return JSON.parse(content);
            } catch (error) {
                // No attributes file exists
                return [];
            }
        } catch (error) {
            console.error(`Error getting attributes for mailbox ${mailbox}:`, error);
            return [];
        }
    }
}