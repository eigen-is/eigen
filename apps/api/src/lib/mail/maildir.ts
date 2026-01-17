import type {User} from "better-auth";
import type {Attachment, Email, EmailSummary, MaildirMailbox} from "@workspace/lib/types/mail";
import {simpleParser} from "./mail-parser";
import {createELMContent} from "./mailfile";
import {createUniqueMessageId, getMailIDfromFileName, getStandardMailboxFlags} from "./mailutils";
import {welcomeMail} from "./welcome.ts";
import DOMPurify from 'isomorphic-dompurify';
import maildb from "./maildb.ts";
import type {HomeInterface} from "../home/types";
import {sendMail, draftToMailOptions} from './sender';
import type {EmailDraft} from "@workspace/lib/types/mail";
import {SSEventType, type SSEvent} from "@workspace/lib/types/sse";
import {LocalStorage} from "../storage";

export default class Maildir {
    private basePath: string;
    private user: User;
    private home: HomeInterface;
    private storage: LocalStorage;
    private db!: maildb;
    private notifyCallback: (event: SSEvent) => void | undefined;

    constructor(home: HomeInterface, notifyCallback: (event: SSEvent) => void | undefined) {
        this.home = home;
        this.user = this.home.user;
        this.basePath = 'Maildir';
        this.storage = new LocalStorage(`${home.homeDir}/eigen.mail`);
        this.notifyCallback = notifyCallback;
    }

    public async init() {
        // check if basePath exists
        const basePathExists = await this.storage.dirExists(this.basePath);
        if (!basePathExists) {
            await this.createMailboxes();
            await this.mailboxDeliver(welcomeMail(this.user.name, this.user.email), false);
        }
        this.db = new maildb(this.home);
        await this.db.init();
    }

    public async size(): Promise<number> {
        // get total size of mailbox
        return (await this.storage.dirSize('eigen.mail')) || this.db.size();
    }

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
            const entries = await this.storage.readdir(this.basePath, {withFileTypes: true});

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
            const mailboxExists = await this.storage.dirExists(mailboxPath);
            if (mailboxExists) {
                console.error(`Cannot create: mailbox ${mailbox} already exists`);
                return false;
            }

            // Create the mailbox directory structure
            await this.storage.mkdir(mailboxPath);

            // Create the cur, new, and tmp subdirectories
            await this.storage.mkdir(this.storage.pathJoin(mailboxPath, 'cur'));
            await this.storage.mkdir(this.storage.pathJoin(mailboxPath, 'new'));
            await this.storage.mkdir(this.storage.pathJoin(mailboxPath, 'tmp'));

            // Store attributes if provided
            if (attributes.length > 0) {
                const attributesPath = this.sanitizeDirName(mailbox, '.attributes');
                await this.storage.file(attributesPath).write(JSON.stringify(attributes));
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

    public async mailboxDeliver(message: string, notify: boolean = true): Promise<string> {
        try {
            // Create a unique filename
            const messageId = createUniqueMessageId();
            const filename = `${messageId}.eml`;
            const filePath = this.storage.pathJoin(this.basePath, 'new', filename);

            // Write the message to the new directory
            await this.storage.file(filePath).write(message);

            // parse the message
            this.mailboxGet('').then(async () => {
                this.messageGet(messageId).then(async (parsedMessage) => {
                    if (this.notifyCallback && notify) {
                        this.notifyCallback({
                            type: SSEventType.MAIL_RECEIVED,
                            title: `New email: ${parsedMessage?.subject || 'No subject'}`,
                            body: `${parsedMessage?.textShort || 'No body'}`,
                            link: `/mail/box/inbox?mailId=${parsedMessage?.id}`,
                            tag: 'mail'
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
            const curPath = this.storage.pathJoin(mailboxPath, 'cur');
            const newPath = this.storage.pathJoin(mailboxPath, 'new');

            // Get messages from new directory (unread)
            if (await this.storage.dirExists(newPath)) {
                const newFiles = await this.storage.readdir(newPath);
                for (const fileName of newFiles) {
                    // move to cur (skip if file no longer exists)
                    const srcPath = this.storage.pathJoin(newPath, fileName);
                    if (await this.storage.fileExists(srcPath)) {
                        await this.storage.rename(srcPath, this.storage.pathJoin(curPath, fileName));
                    }
                }
            }

            // Get all messages stored in db form dir
            const dbMessages = await this.db.getAllEmails(mailbox);

            // Get messages from cur directory (read)
            if (await this.storage.dirExists(curPath)) {
                const curFiles = await this.storage.readdir(curPath);
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

    public async messageGetFile(messageId: string): Promise<ArrayBuffer> {
        const email = await this.db.getEmail(messageId);
        if (!email) {
            throw new Error('Email not found');
        }
        const filePath = this.getFullPath({id: messageId, mailbox: email.mailbox});
        const file = this.storage.file(filePath);
        return await file.arrayBuffer();
    }

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

            if (!await this.storage.fileExists(filePath)) {
                console.error(`Cannot delete: file for message ${messageId} not found`);
                return false;
            }

            await this.storage.unlink(filePath);
            return true;
        } catch (error) {
            console.error(`Error deleting message ${messageId}:`, error);
            return false;
        }
    }

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

            if (!await this.storage.fileExists(sourcePath)) {
                console.error(`Cannot move: file for message ${messageId} not found`);
                return false;
            }

            this.db.moveEmail(messageId, targetMailbox);
            // use fs move function to move
            await this.storage.rename(sourcePath, targetFilePath);

            return true;
        } catch (error) {
            console.error(`Error moving message ${messageId} to mailbox ${targetMailbox}:`, error);
            return false;
        }
    }

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

            if (!await this.storage.fileExists(sourcePath)) {
                console.error(`Cannot copy: file for message ${messageId} not found`);
                return false;
            }

            // Read the file content using home.fs
            const content = await this.storage.file(sourcePath).text();

            // Write to the target location using home.fs
            await this.storage.file(targetFilePath).write(content);

            return true;
        } catch (error) {
            console.error(`Error copying message ${messageId} to mailbox ${targetMailbox}:`, error);
            return false;
        }
    }
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
            const filePath = this.storage.pathJoin(draftPath, filename);

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
                cc: email.cc || undefined,
                bcc: email.bcc || undefined,
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
            await this.storage.file(filePath).write(emptyMessage);

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

    public async messageSend(mailToSend: EmailDraft): Promise<EmailDraft | null> {
        const mail = await this.messageHandleDraft(mailToSend);
        if (!mail) return null;
        try {
            const mailOptions = draftToMailOptions(mail, this.home.user.email);
            const sent = await sendMail(mailOptions);
            if (sent) await this.messageMove(mail.id, 'sent');
        } catch (error) {
            console.error('Error sending email:', error);
            return null;
        }
        return mail;
    }

    public async messageSetRead(messageId: string, read: boolean): Promise<boolean> {
        return (await this.db.setRead(messageId, read)) !== null;
    }

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
                const mailboxExists = await this.storage.dirExists(mailboxPath);
                if (!mailboxExists) {
                    // Create mailbox if it doesn't exist
                    await this.storage.mkdir(mailboxPath);

                    // Create cur, new, and tmp directories
                    await this.storage.mkdir(this.storage.pathJoin(mailboxPath, 'cur'));
                    await this.storage.mkdir(this.storage.pathJoin(mailboxPath, 'new'));
                    await this.storage.mkdir(this.storage.pathJoin(mailboxPath, 'tmp'));

                    // Create attributes file with standard flags
                    const attributesPath = this.storage.pathJoin(mailboxPath, '.attributes');
                    const attributes = getStandardMailboxFlags(mailbox);
                    await this.storage.file(attributesPath).write(JSON.stringify(attributes));
                }
            }
        } catch (error) {
            console.error('Error creating mailboxes:', error);
        }
    }

    private async processNestedMailboxes(parentPath: string, mailboxes: MaildirMailbox[]) {
        try {
            // Get all entries in the parent directory
            const parentFullPath = this.storage.pathJoin(this.basePath, `.${parentPath}`);
            const entries = await this.storage.readdir(parentFullPath);

            // Check each entry to see if it's a directory
            for (const entry of entries) {
                const entryPath = this.storage.pathJoin(parentFullPath, entry);
                const stats = await this.storage.stat(entryPath);

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

    private async getMailboxInfo(mailboxName: string): Promise<MaildirMailbox | null> {
        try {
            const mailboxPath = await this.sanitizeDirName(mailboxName);

            // Check if mailbox exists
            if (!await this.storage.dirExists(mailboxPath)) {
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
            const file = this.storage.file(filePath);
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

    private async getMailboxAttributes(mailbox: string): Promise<string[]> {
        try {
            const attributesPath = this.storage.pathJoin(this.sanitizeDirName(mailbox), '.attributes');

            // Check if attributes file exists
            if (!await this.storage.fileExists(attributesPath)) {
                // If file doesn't exist, return standard attributes based on mailbox name
                const mailboxName = this.storage.pathBasename(mailbox);
                return getStandardMailboxFlags(mailboxName);
            }

            // Read attributes from file
            return await this.storage.file(attributesPath).json();
        } catch (error) {
            console.error(`Error getting attributes for mailbox ${mailbox}:`, error);
            return [];
        }
    }
}