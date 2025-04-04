import type {User} from "better-auth";
import type {Attachment, Email, EmailSummary, MaildirMailbox} from "./mailtypes";
import {simpleParser} from "./mail-parser";
import {createELMContent} from "./mailfile";
import {createUniqueMessageId, getMailIDfromFileName, getStandardMailboxFlags} from "./mailutils";
import {welcomeMail} from "./welcome.ts";
import DOMPurify from 'isomorphic-dompurify';
import maildb from "./maildb.ts";
import type {Home} from "../home/home.ts";
import nodemailer from 'nodemailer';
import type {EmailDraft} from "../../types/mail.ts";
import type {EigenNotification} from "../../types/notification.ts";

export default class Maildir {
    private basePath: string;
    private user: User;
    private home: Home;
    private db!: maildb;
    private notifyCallback: (event: EigenNotification) => void | undefined;

    constructor(home: Home, notifyCallback: (event: EigenNotification) => void | undefined) {
        this.home = home;
        this.user = this.home.user;
        this.basePath = 'eigen.mail/Maildir';
        this.notifyCallback = notifyCallback;
    }

    public async init() {
        // check if basePath exists
        const basePathExists = await this.home.fs.dirExists(this.basePath);
        if (!basePathExists) {
            await this.createMailboxes();
            await this.mailboxDeliver(welcomeMail(this.user.name));
        }
        this.db = new maildb(this.home);
        await this.db.init();
    }

    public async size(): Promise<number> {
        // get total size of mailbox
        return (await this.home.fs.dirSize('eigen.mail')) || this.db.size();
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
            const entries = await this.home.fs.readdir(this.basePath, {withFileTypes: true});

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

    public async mailboxCreate(mailbox: string, attributes: string[] = []): Promise<boolean> {
        try {
            // Check if mailbox already exists
            const mailboxPath = await this.sanitizeDirName(mailbox);
            const mailboxExists = await this.home.fs.dirExists(mailboxPath);
            if (mailboxExists) {
                console.error(`Cannot create: mailbox ${mailbox} already exists`);
                return false;
            }

            // Create the mailbox directory structure
            await this.home.fs.mkdir(mailboxPath);

            // Create the cur, new, and tmp subdirectories
            await this.home.fs.mkdir(this.home.fs.pathJoin(mailboxPath, 'cur'));
            await this.home.fs.mkdir(this.home.fs.pathJoin(mailboxPath, 'new'));
            await this.home.fs.mkdir(this.home.fs.pathJoin(mailboxPath, 'tmp'));

            // Store attributes if provided
            if (attributes.length > 0) {
                const attributesPath = this.sanitizeDirName(mailbox, '.attributes');
                await this.home.fs.file(attributesPath).write(JSON.stringify(attributes));
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
            const filePath = this.home.fs.pathJoin(this.basePath, 'new', filename);

            // Write the message to the new directory
            await this.home.fs.file(filePath).write(message);

            // parse the message
            this.mailboxGet('').then(async () => {
                this.messageGet(messageId).then(async (parsedMessage) => {
                    if (this.notifyCallback) {
                        this.notifyCallback({
                            type: 'mail',
                            title: 'New email',
                            description: `${parsedMessage?.subject || 'No subject'}`,
                        });
                    }
                });
            });

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
            const curPath = this.home.fs.pathJoin(mailboxPath, 'cur');
            const newPath = this.home.fs.pathJoin(mailboxPath, 'new');

            // Get messages from new directory (unread)
            if (await this.home.fs.dirExists(newPath)) {
                const newFiles = await this.home.fs.readdir(newPath);
                for (const fileName of newFiles) {
                    // move to cur
                    await this.home.fs.rename(
                        this.home.fs.pathJoin(newPath, fileName),
                        this.home.fs.pathJoin(curPath, fileName)
                    );
                }
            }

            // Get all messages stored in db form dir
            const dbMessages = await this.db.getAllEmails(mailbox);

            // Get messages from cur directory (read)
            if (await this.home.fs.dirExists(curPath)) {
                const curFiles = await this.home.fs.readdir(curPath);
                for (const fileName of curFiles) {
                    // is parsed?
                    const cachedMessage = dbMessages.find((m) => m.id === getMailIDfromFileName(fileName));
                    if (cachedMessage) {
                        messages.push(cachedMessage);

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
                const parsed = await this.parseMessage(messageId, cached.mailbox);
                if (parsed !== null) {
                    // strip the attachment data for now
                    parsed.attachments.forEach(a => {
                        a.content = new Buffer(0);
                    });

                    return {...parsed, ...cached} as Email;
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

            // delete from db
            await this.db.deleteEmail(messageId);

            // Delete the file
            const filePath = this.getFullPath(message);

            if (!await this.home.fs.fileExists(filePath)) {
                console.error(`Cannot delete: file for message ${messageId} not found`);
                return false;
            }

            await this.home.fs.unlink(filePath);
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

            if (!await this.home.fs.fileExists(sourcePath)) {
                console.error(`Cannot move: file for message ${messageId} not found`);
                return false;
            }

            this.db.moveEmail(messageId, targetMailbox);
            // use fs move function to move
            await this.home.fs.rename(sourcePath, targetFilePath);

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

            if (!await this.home.fs.fileExists(sourcePath)) {
                console.error(`Cannot copy: file for message ${messageId} not found`);
                return false;
            }

            // Read the file content using home.fs
            const content = await this.home.fs.file(sourcePath).text();

            // Write to the target location using home.fs
            await this.home.fs.file(targetFilePath).write(content);

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
    public async messageHandleDraft(email: EmailDraft): Promise<EmailDraft> {
        try {
            // Check if Drafts mailbox exists
            let draftsMailbox = await this.mailboxExists('Drafts');
            if (!draftsMailbox) {
                // Create Drafts mailbox if it doesn't exist
                await this.mailboxCreate('Drafts', ['\\HasNoChildren', '\\Drafts']);
                draftsMailbox = await this.mailboxExists('Drafts') as MaildirMailbox;
            }

            // Create a unique message ID
            const createNewDraft = (email.id || '').trim() == '';
            const messageId = createNewDraft ? createUniqueMessageId() : email.id;
            const draftPath = await this.sanitizeDirName('Drafts', 'cur');
            const filename = messageId + '.eml';
            const filePath = this.home.fs.pathJoin(draftPath, filename);

            const user = this.home.user;
            email.from = {
                value: [{
                    address: user.email,
                    name: user.name,
                }],
                html: user.email,
                text: user.email,
            };

            // Create an empty message template with all required properties
            const emptyMessage = createELMContent({
                id: messageId,
                subject: email.subject || '',
                from: email.from || undefined,
                to: email.to || undefined,
                fromShort: (email.from?.value[0]?.name || email.from?.value[0]?.address || 'Unknown'),
                textShort: email.text || '',
                date: new Date(),
                text: email.text || '',
                html: email.html || '',
                textAsHtml: email.textAsHtml || '',
                attachments: [],
                headers: new Map(),
                headerLines: [], // Add the required headerLines property
                references: [],
                messageId: `<${messageId}@eigen.local>`,
                inReplyTo: undefined,
                isRead: true,
                isStarred: false,
                isDraft: true,
                size: 0,
                hasAttachments: false,
                mailbox: draftsMailbox.name,
                _isParsed: false
            });

            // Use home.fs for file content operations
            await this.home.fs.file(filePath).write(emptyMessage);

            const parsedMessage = await this.parseMessage(messageId, draftsMailbox.name);
            if (!parsedMessage) {
                throw new Error(`Failed to parse draft message: ${messageId}`);
            }

            parsedMessage.isDraft = true;
            parsedMessage.mailbox = draftsMailbox.name;

            // Add message to db
            await this.db.addEmail(parsedMessage as EmailSummary);

            // Get the newly created message
            const message = await this.messageGet(messageId);
            if (!message) {
                throw new Error(`Failed to create draft message: ${messageId}`);
            }

            return parsedMessage as EmailDraft;
        } catch (error) {
            console.error('Error creating draft message:', error);
            throw error;
        }
    }

    /**
     * Sends a draft message
     * @param mail Draft message to send
     * @returns True if successful
     */
    // @ts-ignore - Ignore TypeScript errors in this method
    public async messageSend(mailToSend: EmailDraft): Promise<EmailDraft | null> {
        // update message
        const mail = await this.messageHandleDraft(mailToSend);
        if (!mail) {
            return null;
        }

        // use nodemailer, to send email to reinder@eigen.is
        // @ts-ignore - Ignore nodemailer type errors
        const transporter = nodemailer.createTransport({
            sendmail: true,
            newline: 'unix',
            path: '/usr/sbin/sendmail'
        });

        try {
            // Convert the mail object to the format needed for nodemailer
            // @ts-ignore - Ignore type errors in mail conversion
            const nodemailerMail = {
                // From address - use the address and name from the mail object
                from: mail.from?.value?.[0] ?
                    {name: mail.from.value[0].name, address: mail.from.value[0].address} :
                    this.home.user.email,

                // To addresses - convert the array of addresses to the format needed
                // @ts-ignore - Ignore type errors in mail conversion
                to: mail.to?.value?.map(recipient => ({
                    name: recipient.name,
                    address: recipient.address
                })) || [],

                // CC addresses if present
                // @ts-ignore - Ignore type errors in mail conversion
                ...(mail.cc?.value?.length ? {
                    // @ts-ignore - Ignore type errors in mail conversion
                    cc: mail.cc.value.map(recipient => ({
                        name: recipient.name,
                        address: recipient.address
                    }))
                } : {}),

                // BCC addresses if present
                // @ts-ignore - Ignore type errors in mail conversion
                ...(mail.bcc?.value?.length ? {
                    // @ts-ignore - Ignore type errors in mail conversion
                    bcc: mail.bcc.value.map(recipient => ({
                        name: recipient.name,
                        address: recipient.address
                    }))
                } : {}),

                // Subject
                subject: mail.subject || '(No subject)',

                // Text content
                text: mail.text || '',
            };

            // Send mail with defined transport object

            console.log(nodemailerMail);

            try {
                // @ts-ignore - Ignore sendMail type errors
                const result = await transporter.sendMail(nodemailerMail);
            } catch (error) {
                console.error('Error sending email:', error);
            }

            // move message to send directory
            await this.messageMove(mail.id, 'sent');
        } catch (error) {
            console.error('Error sending email:', error);
            return null;
        }

        return mail;
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

            // parse the message to get the attachment
            const parsedMessage = await this.parseMessage(messageId, message.mailbox);

            return parsedMessage?.attachments[index] || null;
        } catch (error) {
            console.error(`Error getting attachment ${index} from message ${messageId}:`, error);
            return null;
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
                const mailboxExists = await this.home.fs.dirExists(mailboxPath);
                if (!mailboxExists) {
                    // Create mailbox if it doesn't exist
                    await this.home.fs.mkdir(mailboxPath);

                    // Create cur, new, and tmp directories
                    await this.home.fs.mkdir(this.home.fs.pathJoin(mailboxPath, 'cur'));
                    await this.home.fs.mkdir(this.home.fs.pathJoin(mailboxPath, 'new'));
                    await this.home.fs.mkdir(this.home.fs.pathJoin(mailboxPath, 'tmp'));

                    // Create attributes file with standard flags
                    const attributesPath = this.home.fs.pathJoin(mailboxPath, '.attributes');
                    const attributes = getStandardMailboxFlags(mailbox);
                    await this.home.fs.file(attributesPath).write(JSON.stringify(attributes));
                }
            }
        } catch (error) {
            console.error('Error creating mailboxes:', error);
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
            const parentFullPath = this.home.fs.pathJoin(this.basePath, `.${parentPath}`);
            const entries = await this.home.fs.readdir(parentFullPath);

            // Check each entry to see if it's a directory
            for (const entry of entries) {
                const entryPath = this.home.fs.pathJoin(parentFullPath, entry);
                const stats = await this.home.fs.stat(entryPath);

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
            if (!await this.home.fs.dirExists(mailboxPath)) {
                // Directory doesn't exist
                return null;
            }

            // Get mailbox attributes
            const attributes = await this.getMailboxAttributes(mailboxName);

            // For the root mailbox (INBOX), ensure it has the \Inbox flag
            if (!mailboxName && !attributes.includes('\\Inbox')) {
                attributes.push('\\Inbox');
            }
            // Create the mailbox object
            const mailbox: MaildirMailbox = {
                path: mailboxName,
                name: mailboxName ? mailboxName.split('.').pop() || mailboxName : 'INBOX',
                delimiter: '.',
                flags: attributes, // Use the attributes as flags
                total: await this.db.getEmailsCount(mailboxName),
                unread: await this.db.getEmailsCountUnread(mailboxName),
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

    private async parseMessage(messageId: string, mailbox: string): Promise<Email | null> {
        try {
            mailbox = mailbox.toLowerCase();
            const filePath = this.getFullPath({id: messageId, mailbox: mailbox});
            const file = this.home.fs.file(filePath);
            const fileContent = await file.text();

            // time to parse the message
            const start = Date.now();
            const parsedMail = await simpleParser(fileContent, {});
            const end = Date.now();
            console.log(`Parsed message ${messageId} in ${end - start}ms`);

            // just to be sure, dompurify html
            if (parsedMail.html) {
                parsedMail.html = DOMPurify.sanitize(parsedMail.html, {FORCE_BODY: true});
                // replace newlines and all types of whitespace with a single space
                parsedMail.html = parsedMail.html.replace(/\s+/g, ' ').trim();
            }

            parsedMail.isDraft = mailbox === 'drafts';
            parsedMail.isRead = parsedMail.isDraft;
            parsedMail.isStarred = false;
            parsedMail.isDeleted = mailbox === 'trash';
            // @ts-ignore
            parsedMail.size = file.size;

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
     * Gets mailbox attributes
     * @param mailbox Mailbox name
     * @returns Array of IMAP attributes
     */
    private async getMailboxAttributes(mailbox: string): Promise<string[]> {
        try {
            const attributesPath = this.home.fs.pathJoin(this.sanitizeMailboxPath(mailbox), '.attributes');

            // Check if attributes file exists
            if (!await this.home.fs.fileExists(attributesPath)) {
                // If file doesn't exist, return standard attributes based on mailbox name
                const mailboxName = this.home.fs.pathBasename(mailbox);
                return getStandardMailboxFlags(mailboxName);
            }

            // Read attributes from file
            return await this.home.fs.file(attributesPath).json();
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