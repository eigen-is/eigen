import type {User} from "better-auth";
import type {Attachment, Email, EmailSummary, MaildirMailbox} from "./mailtypes";
import {simpleParser} from "./mail-parser";
import * as path from "path";
import * as fs from "node:fs/promises";
import {watch} from "node:fs";
import {createELMContent} from "./mailfile";
import {fsGetDirName} from "../fs/fs";
import Bun from 'bun';
import {
    createUniqueMessageId,
    fsDirectoryExists,
    fsFileExists,
    getMailIDfromFileName,
    getStandardMailboxFlags,
    isSpecialMailbox
} from "./mailutils";
import {welcomeMail} from "./welcome.ts";
import DOMPurify from 'isomorphic-dompurify';
import maildb from "./maildb.ts";

export default class Maildir {
    private basePath: string;
    private user: User;
    private db!: maildb;

    constructor(user: User) {
        this.user = user;
        this.basePath = fsGetDirName(user, 'eigen.mail/Maildir');
    }

    public async init() {
        // check if basePath exists
        const basePathExists = await fsDirectoryExists(this.basePath);
        if (!basePathExists) {
            await this.createMailboxes();
            await this.mailboxDeliver(welcomeMail(this.user.name));
        }
        this.db = new maildb(this.user);
        await this.db.init();
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
                    await fs.mkdir(mailboxPath, {recursive: true});

                    // Create cur, new, and tmp directories
                    await fs.mkdir(path.join(mailboxPath, 'cur'), {recursive: true});
                    await fs.mkdir(path.join(mailboxPath, 'new'), {recursive: true});
                    await fs.mkdir(path.join(mailboxPath, 'tmp'), {recursive: true});

                    // Create attributes file with standard flags
                    const attributesPath = path.join(mailboxPath, '.attributes');
                    const attributes = getStandardMailboxFlags(mailbox);
                    await Bun.file(attributesPath).write(JSON.stringify(attributes));
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
            const entries = await fs.readdir(this.basePath, {withFileTypes: true});

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
            const mailboxPath = await this.sanitizeDirName(mailboxName);

            // Check if mailbox exists
            if (!await fsDirectoryExists(mailboxPath)) {
                // Directory doesn't exist
                return null;
            }

            // Get mailbox attributes
            const attributes = await this.getMailboxAttributes(mailboxName);

            // For the root mailbox (INBOX), ensure it has the \Inbox flag
            if (!mailboxName && !attributes.includes('\\Inbox')) {
                attributes.push('\\Inbox');
            }

            // todo: get number of messages in mailbox - using db to speed up things


            // Create the mailbox object
            const mailbox: MaildirMailbox = {
                path: mailboxName,
                name: mailboxName ? mailboxName.split('.').pop() || mailboxName : 'INBOX',
                delimiter: '.',
                flags: attributes, // Use the attributes as flags
                total: 0,
                unread: 0
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
    private sanitizeDirName(mailbox: string, sub: string = '') {
        let dirname = `${this.basePath}/.${mailbox.toLowerCase().replace('/', '.')}`;
        // replace .. with . and // with /
        dirname = dirname.replace(/\.{2,}/g, '.');
        dirname = dirname.replace(/\/+/g, '/');
        return sub ? `${dirname}/${sub}` : dirname;
    }

    private getFullPath(mail: { id: string, mailbox: string }) {
        return `${this.sanitizeDirName(mail.mailbox)}/cur/${mail.id}.eml`;
    }

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
            await fs.mkdir(mailboxPath, {recursive: true});

            // Create the cur, new, and tmp subdirectories
            await fs.mkdir(path.join(mailboxPath, 'cur'), {recursive: true});
            await fs.mkdir(path.join(mailboxPath, 'new'), {recursive: true});
            await fs.mkdir(path.join(mailboxPath, 'tmp'), {recursive: true});

            // Store attributes if provided
            if (attributes.length > 0) {
                const attributesPath = this.sanitizeDirName(mailbox, '.attributes');
                await Bun.write(attributesPath, JSON.stringify(attributes));
            }

            return true;
        } catch (error) {
            console.error(`Error creating mailbox ${mailbox}:`, error);
            return false;
        }
    }

    public async mailboxExists(mailbox: string): Promise<MaildirMailbox | false> {
        return await this.getMailboxInfo(mailbox) || false;
    }

    public async mailboxWatch($mailbox: string, $callback: (event: string, filename: string) => void) {
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
    public async mailboxGet(mailbox: string): Promise<EmailSummary[] | false> {
        try {
            const mailboxPath = await this.sanitizeDirName(mailbox);
            const mailboxInfo = await this.mailboxExists(mailbox);

            // Check if mailbox exists
            if (!mailboxInfo) {
                console.error(`Cannot get messages: mailbox ${mailbox} does not exist`);
                return false;
            }

            const messages: EmailSummary[] = [];
            const curPath = path.join(mailboxPath, 'cur');
            const newPath = path.join(mailboxPath, 'new');

            // Get messages from new directory (unread)
            if (await fsDirectoryExists(newPath)) {
                const newFiles = await fs.readdir(newPath);
                for (const fileName of newFiles) {
                    // move to cur
                    await fs.rename(path.join(newPath, fileName), path.join(curPath, fileName));
                }
            }

            // Get all messages stored in db form dir
            const dbMessages = await this.db.getAllEmails(mailbox);

            // Get messages from cur directory (read)
            if (await fsDirectoryExists(curPath)) {
                const curFiles = await fs.readdir(curPath);
                for (const fileName of curFiles) {
                    // is parsed?
                    const cachedMessage = dbMessages.find((m) => m.id === getMailIDfromFileName(fileName));
                    if (cachedMessage) {
                        messages.push(cachedMessage);
                        continue;
                    } else {
                        const message = await this.parseMessage(getMailIDfromFileName(fileName), mailbox);
                        if (message) {
                            messages.push(message);
                            await this.db.addEmail(message);
                        }
                    }
                }
            }

            return messages;
        } catch (error) {
            console.error(`Error getting messages from mailbox ${mailbox}:`, error);
            return [];
        }
    }

    private async parseMessage(messageId: string,  mailbox: string): Promise<Email | null> {
        try {
            const filePath = this.getFullPath({id: messageId, mailbox: mailbox});
            const fileContent = await Bun.file(filePath).text();

            // time to parse the message
            const start = Date.now();
            const parsedMail = await simpleParser(fileContent, {});
            const end = Date.now();
            console.log(`Parsed message ${messageId} in ${end - start}ms`);

            // just to be sure, dompurify html
            if (parsedMail.html) {
                parsedMail.html = DOMPurify.sanitize(parsedMail.html, {FORCE_BODY: true});
            }

            // Create the Email object with the correct ID and path information
            return {
                ...parsedMail,
                id: messageId,
                mailbox: mailbox,
                hasAttachments: (parsedMail.attachments && parsedMail.attachments.length > 0),
                fromShort: (parsedMail.from?.value[0]?.name || parsedMail.from?.value[0]?.address || 'Unknown'),
                textShort: parsedMail.text || ''
            } as Email;
        } catch (error) {
            console.error(`Error parsing message ${messageId}:`, error);
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
            // get mail from db
            const cached = await this.db.getEmail(messageId);
            if (cached) {
                const parsed = this.parseMessage(messageId, cached.mailbox);
                if (parsed) {
                    return parsed;
                }
            } else {
                console.error('Message not found in db', messageId);
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
            const filePath = this.getFullPath(message);

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
     * Moves a message to another mailbox
     * @param messageId Message ID
     * @param targetMailbox Target mailbox name
     * @returns True if successful
     */
    public async messageMove(messageId: string, targetMailbox: string): Promise<boolean> {
        try {
            // Find the message
            const message = await this.messageGet(messageId);
            if (!message) {
                console.error(`Cannot move: message ${messageId} not found`);
                return false;
            }

            // Check if target mailbox exists
            const target = await this.mailboxExists(targetMailbox);
            if (!target) {
                console.error(`Cannot move: target mailbox ${targetMailbox} does not exist`);
                return false;
            }

            // Move the file
            const sourcePath = this.getFullPath(message);
            const targetFilePath = this.getFullPath({id: message.id, mailbox: targetMailbox});


            if (!await fsFileExists(sourcePath)) {
                console.error(`Cannot move: file for message ${messageId} not found`);
                return false;
            }

            // use fs move function to move
            await fs.rename(sourcePath, targetFilePath);

            this.db.moveEmail(messageId, targetMailbox);

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
            if (!message) {
                console.error(`Cannot copy: message ${messageId} not found`);
                return false;
            }

            // Check if target mailbox exists
            const targetMailboxInfo = await this.mailboxExists(targetMailbox);
            if (!targetMailboxInfo) {
                console.error(`Cannot copy: target mailbox ${targetMailbox} does not exist`);
                return false;
            }
            // Move the file
            const sourcePath = this.getFullPath(message);
            const targetFilePath = this.getFullPath({id: message.id, mailbox: targetMailbox});

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
            const filename = messageId + '.eml';
            const filePath = path.join(draftPath, filename);

            // Create an empty message template with all required properties
            const emptyMessage = createELMContent({
                id: messageId,
                subject: '',
                from: undefined,
                to: undefined,
                fromShort: '',
                textShort: '',
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
                isStarred: false,
                isDraft: true,
                hasAttachments: false,
                mailbox: 'Drafts',
                _isParsed: false
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
        return false;
    }

    /**
     * Sets the read status of a message
     * @param messageId Message ID
     * @param read True to mark as read, false to mark as unread
     * @returns True if successful
     */
    public async messageSetRead(messageId: string, read: boolean): Promise<boolean> {
        return (await this.db.setRead(messageId, read)) !== null;
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