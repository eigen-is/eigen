import type {User} from "better-auth";
import type { Email, Attachment } from "./mailtypes";
import { simpleParser } from "./mail-parser";
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
    createFileNameWithFlags,
    createUniqueMessageId,
    isSpecialMailbox,
    getStandardMailboxFlags,
    fsDirectoryExists,
    fsFileExists
} from "./mailutils";

// Define a custom interface that extends Mailbox for our implementation
interface MaildirMailbox  {
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
        const basePathExists = await fsDirectoryExists(this.basePath);
        if (!basePathExists) {
            await this.createMailboxes();
        }
    }

    /**
     * Creates the standard mailboxes for a new user
     */
    private async createMailboxes(): Promise<void> {
        try {
            // Create the standard mailboxes
            const standardMailboxes = ['', 'Sent', 'Drafts', 'Trash', 'Spam', 'Archive'];
            
            for (const mailbox of standardMailboxes) {
                const mailboxPath = await this.sanitizeDirName(mailbox);
                
                // Check if mailbox already exists
                const mailboxExists = await fsDirectoryExists(mailboxPath);
                if (!mailboxExists) {
                    // Create mailbox if it doesn't exist
                    await fs.mkdir(mailboxPath, { recursive: true });
                    
                    // Create cur, new, and tmp directories
                    await fs.mkdir(path.join(mailboxPath, 'cur'), { recursive: true });
                    await fs.mkdir(path.join(mailboxPath, 'new'), { recursive: true });
                    await fs.mkdir(path.join(mailboxPath, 'tmp'), { recursive: true });
                    
                    // Create attributes file with standard flags
                    const attributesPath = path.join(mailboxPath, '.attributes');
                    const attributes = getStandardMailboxFlags(mailbox);
                    await Bun.file(attributesPath).write( JSON.stringify(attributes) );
                }
            }
        } catch (error) {
            console.error('Error creating mailboxes:', error);
        }
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
            const mailboxExists = await fsDirectoryExists(mailboxPath);
            if (!mailboxExists) {
                // Directory doesn't exist
                return null;
            }
            
            // Check for cur and new directories
            const curPath = path.join(mailboxPath, 'cur');
            const newPath = path.join(mailboxPath, 'new');
            
            const curExists = await fsDirectoryExists(curPath);
            const newExists = await fsDirectoryExists(newPath);
            
            if (!curExists || !newExists) {
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
            const mailboxExists = await fsDirectoryExists(await this.sanitizeDirName(mailbox));
            if (mailboxExists) {
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
            // Check if the mailbox is special
            if (await this.checkSpecialMailbox(oldName)) {
                console.error(`Cannot rename special mailbox ${oldName}`);
                return false;
            }
            
            const oldPath = await this.sanitizeDirName(oldName);
            const newPath = await this.sanitizeDirName(newName);
            
            // Check if the source mailbox exists
            if (!await fsDirectoryExists(oldPath)) {
                console.error(`Source mailbox ${oldName} does not exist`);
                return false;
            }
            
            // Check if the destination mailbox already exists
            if (await fsDirectoryExists(newPath)) {
                console.error(`Destination mailbox ${newName} already exists`);
                return false;
            }
            
            // Rename the mailbox
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
            // Check if the mailbox is special
            if (await this.checkSpecialMailbox(mailbox)) {
                console.error(`Cannot delete special mailbox ${mailbox}`);
                return false;
            }
            
            const mailboxPath = await this.sanitizeDirName(mailbox);
            
            // Check if the mailbox exists
            if (!await fsDirectoryExists(mailboxPath)) {
                console.error(`Mailbox ${mailbox} does not exist`);
                return false;
            }
            
            // Delete the mailbox recursively
            await fs.rm(mailboxPath, { recursive: true });
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
            const mailboxExists = await this.mailboxExists(mailbox);
            if (!mailboxExists) {
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
            watch(newPath, (eventType, filename) => {
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

    /**
     * Delivers a message to the INBOX
     * @param message Message content
     * @returns Filename of the delivered message
     */
    public async mailboxDeliver(message: string): Promise<string> {
        try {
            // Create a unique filename
            const messageId = createUniqueMessageId();
            const filename = `${messageId}.eml`;
            const filePath = path.join(this.basePath, 'new', filename);
            
            // Write the message to the new directory
            await fs.writeFile(filePath, message);
            
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
            if (!await fsDirectoryExists(mailboxPath)) {
                console.error(`Cannot get messages: mailbox ${mailbox} does not exist`);
                return false;
            }
            
            const messages: Email[] = [];
            const curPath = path.join(mailboxPath, 'cur');
            const newPath = path.join(mailboxPath, 'new');
            
            // Get messages from new directory (unread)
            if (await fsDirectoryExists(newPath)) {
                try {
                    const newFiles = await fs.readdir(newPath);
                    for (const fileName of newFiles) {
                        const message = await this.parseMessage(fileName, path.join(newPath, fileName), true, mailboxPath);
                        if (message) {
                            messages.push(message);
                        }
                    }
                } catch (error) {
                    console.error(`Error reading new messages in ${mailbox}:`, error);
                }
            }
            
            // Get messages from cur directory (read)
            if (await fsDirectoryExists(curPath)) {
                try {
                    const curFiles = await fs.readdir(curPath);
                    for (const fileName of curFiles) {
                        const message = await this.parseMessage(fileName, path.join(curPath, fileName), false, mailboxPath);
                        if (message) {
                            messages.push(message);
                        }
                    }
                } catch (error) {
                    console.error(`Error reading cur messages in ${mailbox}:`, error);
                }
            }
            
            return messages;
        } catch (error) {
            console.error(`Error getting messages from mailbox ${mailbox}:`, error);
            return [];
        }
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
            // Extract the message ID using the utility function
            const messageId = getMailIDfromFileName(fileName);
            
            // const fileContent = await Bun.file(filePath).stream();
            // const parsedMail = await simpleParser(fileContent as unknown as NodeJS.ReadableStream);
            
            const fileContent = await Bun.file(filePath).text();

            // time to parse the message
            const start = Date.now();
            const parsedMail = await simpleParser(fileContent, {});
            const end = Date.now();
            console.log(`Parsed message ${fileName} in ${end - start}ms`);

            // const parsedMail = await simpleParser(fs.createReadStream(filePath));

            // Extract flags from the filename
            const flags = extractFlagsFromFileName(fileName);
            
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
            
            if (!await fsFileExists(filePath)) {
                console.error(`Cannot delete: file for message ${messageId} not found`);
                return false;
            }
            
            await fs.unlink(filePath);
            return true;
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
            
            if (!await fsFileExists(oldPath)) {
                console.error(`Cannot rename: file for message ${messageId} not found`);
                return false;
            }
            
            await fs.rename(oldPath, newPath);
            
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
            if (!await this.mailboxExists(targetMailbox)) {
                console.error(`Cannot move: target mailbox ${targetMailbox} does not exist`);
                return false;
            }
            
            // Determine source and target directories
            const sourceDir = path.basename(message._path); // 'new' or 'cur'
            const targetPath = await this.sanitizeDirName(targetMailbox, sourceDir);
            
            // Move the file
            const sourcePath = path.join(message._path, message._filename);
            const targetFilePath = path.join(targetPath, message._filename);
            
            if (!await fsFileExists(sourcePath)) {
                console.error(`Cannot move: file for message ${messageId} not found`);
                return false;
            }
            
            // Read the file content and write to the target location using Bun (faster)
            await Bun.write(targetFilePath, await Bun.file(sourcePath).text());
            
            // Delete the source file
            await fs.unlink(sourcePath);
            
            return true;
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
            
            if (!await fsFileExists(sourcePath)) {
                console.error(`Cannot copy: file for message ${messageId} not found`);
                return false;
            }
            
            // Read the file content using Bun (faster)
            const content = await Bun.file(sourcePath).text();
            
            // Write to the target location using Bun (faster)
            await Bun.write(targetFilePath, content);
            
            return true;
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
            const messageId = createUniqueMessageId();
            const draftPath = await this.sanitizeDirName('Drafts', 'cur');
            const filename = createFileNameWithFlags(messageId, ['D']); // D flag for draft
            const filePath = path.join(draftPath, filename);
            
            // Create an empty message template with all required properties
            const emptyMessage = createELMContent({
                id: messageId,
                subject: '',
                from: undefined,
                to: undefined,
                date: new Date(),
                text: '',
                html: '',
                textAsHtml: '',
                attachments: [],
                headers: new Map(),
                headerLines: [], // Add the required headerLines property
                references: [],
                messageId: `<${messageId}@eigen.local>`,
                inReplyTo: undefined,
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
            
            if (!await fsFileExists(filePath)) {
                console.error('Cannot update: draft file does not exist');
                return false;
            }
            
            // Make sure the draft has the correct flags
            if (!mail.flags.includes('\\Seen')) {
                mail.flags.push('\\Seen'); // Drafts should be marked as seen
            }
            
            // Ensure the Draft flag is present
            if (!mail.flags.includes('\\Draft')) {
                mail.flags.push('\\Draft');
            }
            
            // Construct email content and update the draft file
            await Bun.write(filePath, createELMContent(mail));
            
            return true;
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
            // Find the message and update the flag if found
            if (!await this.messageGet(messageId)) {
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
     * Checks if a mailbox is a special mailbox that shouldn't be renamed or deleted
     * @param mailbox Mailbox path
     * @returns True if the mailbox is special
     */
    private async checkSpecialMailbox(mailbox: string): Promise<boolean> {
        return isSpecialMailbox(await this.getMailboxAttributes(mailbox));
    }

    /**
     * Gets mailbox attributes
     * @param mailbox Mailbox name
     * @returns Array of IMAP attributes
     */
    private async getMailboxAttributes(mailbox: string): Promise<string[]> {
        try {
            const attributesPath = path.join(this.sanitizeMailboxPath(mailbox), '.attributes');
            
            // Check if attributes file exists
            if (!await fsFileExists(attributesPath)) {
                // If file doesn't exist, return standard attributes based on mailbox name
                const mailboxName = path.basename(mailbox);
                return getStandardMailboxFlags(mailboxName);
            }
            
            // Read attributes from file
            return await Bun.file(attributesPath).json();
        } catch (error) {
            console.error(`Error getting attributes for mailbox ${mailbox}:`, error);
            return [];
        }
    }

    private sanitizeMailboxPath(mailbox: string): string {
        let dirname = `${this.basePath}/.${mailbox.replace('/', '.')}`;
        // replace .. with . and // with /
        dirname = dirname.replace(/\.{2,}/g, '.');
        dirname = dirname.replace(/\/+/g, '/');
        return dirname;
    }
}