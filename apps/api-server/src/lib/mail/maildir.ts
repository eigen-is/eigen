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
        await this.mailboxCreate(``);
        // create .Sent, .Trash, .Drafts
        await this.mailboxCreate(`Sent`);
        await this.mailboxCreate(`Trash`);
        await this.mailboxCreate(`Drafts`);
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
            
            // Count messages in cur and new directories
            const newPath = path.join(mailboxPath, 'new');
            const curPath = path.join(mailboxPath, 'cur');
            
            let totalMessages = 0;
            let unreadMessages = 0;
            
            // Count unread messages (in new directory)
            try {
                await fs.access(newPath, fs.constants.F_OK);
                const newFiles = await fs.readdir(newPath);
                unreadMessages = newFiles.length;
                totalMessages += unreadMessages;
            } catch (error) {
                // New directory doesn't exist
            }
            
            // Count read messages (in cur directory)
            try {
                await fs.access(curPath, fs.constants.F_OK);
                const curFiles = await fs.readdir(curPath);
                totalMessages += curFiles.length;
            } catch (error) {
                // Cur directory doesn't exist
            }
            
            return {
                name: mailboxName || 'INBOX',
                path: mailboxName || 'INBOX',
                delimiter: '.',
                total: totalMessages,
                unread: unreadMessages,
                subscribed: this.subscriptions.has(mailboxName || 'INBOX'),
                flags: []
            };
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
     * @param attributes Optional mailbox attributes
     * @returns True if successful
     */
    public async mailboxCreate(mailbox: string, attributes: string[] = []) {       
        try {
            // create directory and new, cur and tmp subdirectories
            await fs.mkdir(await this.sanitizeDirName(mailbox), {recursive: true});
            await fs.mkdir(await this.sanitizeDirName(mailbox, 'new'), {recursive: true});
            await fs.mkdir(await this.sanitizeDirName(mailbox, 'cur'), {recursive: true});
            await fs.mkdir(await this.sanitizeDirName(mailbox, 'tmp'), {recursive: true});
            
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
            // Sanitize both names
            const oldPath = await this.sanitizeDirName(oldName);
            const newPath = await this.sanitizeDirName(newName);
            
            // Check if old mailbox exists
            try {
                await fs.access(oldPath, fs.constants.F_OK);
            } catch (error) {
                console.error(`Cannot rename: mailbox ${oldName} does not exist`);
                return false;
            }
            
            // Check if new mailbox already exists
            try {
                await fs.access(newPath, fs.constants.F_OK);
                console.error(`Cannot rename: mailbox ${newName} already exists`);
                return false;
            } catch (error) {
                // New mailbox doesn't exist
            }
            
            // Rename the mailbox
            await fs.rename(oldPath, newPath);
            
            // Handle nested mailboxes (e.g., if renaming "prive" to "personal", also rename "prive.family" to "personal.family")
            const allMailboxes = await this.mailboxesList();
            const childMailboxes = allMailboxes.filter(mb => mb.path.startsWith(`${oldName}.`));
            
            for (const childMailbox of childMailboxes) {
                const childNewName = childMailbox.path.replace(new RegExp(`^${oldName}\\.`), `${newName}.`);
                await this.mailboxRename(childMailbox.path, childNewName);
            }
            
            // Update subscriptions if needed
            if (this.subscriptions.has(oldName)) {
                this.subscriptions.delete(oldName);
                this.subscriptions.add(newName);
            }
            
            return true;
        } catch (error) {
            console.error(`Error renaming mailbox from ${oldName} to ${newName}:`, error);
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
            // Don't allow deleting the root mailbox
            if (!mailbox) {
                console.error('Cannot delete the root mailbox');
                return false;
            }
            
            const mailboxPath = await this.sanitizeDirName(mailbox);
            
            // Check if mailbox exists
            try {
                await fs.access(mailboxPath, fs.constants.F_OK);
            } catch (error) {
                console.error(`Cannot delete: mailbox ${mailbox} does not exist`);
                return false;
            }
            
            // Check for child mailboxes
            const allMailboxes = await this.mailboxesList();
            const childMailboxes = allMailboxes.filter(mb => mb.path.startsWith(`${mailbox}.`));
            
            // Delete child mailboxes first
            for (const childMailbox of childMailboxes) {
                await this.mailboxDelete(childMailbox.path);
            }
            
            // Delete the mailbox
            await fs.rm(mailboxPath, { recursive: true });
            
            // Remove from subscriptions if needed
            if (this.subscriptions.has(mailbox)) {
                this.subscriptions.delete(mailbox);
            }
            
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
        const flagPart = filename.split(':')[1];
        if (!flagPart) return [];
        
        // Format is typically "2,flags" where flags are single characters
        const flags = flagPart.split(',')[1] || '';
        const flagArray: string[] = [];
        
        // Map characters to IMAP flags
        if (flags.includes('S')) flagArray.push('\\Seen');
        if (flags.includes('F')) flagArray.push('\\Flagged');
        if (flags.includes('R')) flagArray.push('\\Answered');
        if (flags.includes('D')) flagArray.push('\\Draft');
        if (flags.includes('T')) flagArray.push('\\Deleted');
        
        return flagArray;
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
            const messageId = fileName.split(':')[0];
            
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
            // Find the message in all mailboxes
            const allMailboxes = await this.mailboxesList();
            
            for (const mailbox of allMailboxes) {
                const messages = await this.mailboxGet(mailbox.path);
                if (messages) {
                    // Find message by ID (the filename without extension and flags)
                    const message = messages.find(msg => {
                        // Extract ID from filename (part before the colon)
                        const fileId = msg._filename.split(':')[0];
                        return fileId === messageId;
                    });
                    
                    if (message) {
                        return message;
                    }
                }
            }
            
            console.error(`Message ${messageId} not found in any mailbox`);
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
            const flagMatch = message._filename.match(/:2,([A-Z]*)/);
            let flagStr = flagMatch ? flagMatch[1] : '';
            let newFileName = message._filename;
            
            // Add or remove flag
            if (value) {
                if (!flagStr.includes(mailDirFlag)) {
                    flagStr += mailDirFlag;
                }
            } else {
                flagStr = flagStr.replace(mailDirFlag, '');
            }
            
            // Create new filename
            if (flagMatch) {
                newFileName = message._filename.replace(/:2,[A-Z]*/, `:2,${flagStr}`);
            } else {
                newFileName = `${message._filename}:2,${flagStr}`;
            }
            
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
            // Create a unique message ID
            const messageId = `${Date.now()}.${uuidv4()}`;
            const draftPath = await this.sanitizeDirName('Drafts', 'cur');
            const filename = `${messageId}:2,D`;
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
                flags: ['\\Draft'],
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
        return this.messageFlag(messageId, '\\Seen', read);
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

}