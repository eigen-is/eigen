import type { Email, EmailDraft, EmailSummary, MaildirMailbox } from '@workspace/lib/types/mail';
import { SSEventType } from '@workspace/lib/types/sse';
import { ApiError, STANDARD_MAILBOXES } from '../core';
import { sendMail } from '../core/mailer';
import type { Home } from '../home';
import { parseEml } from './mail-parse';
import MailDB from './maildb';
import { MaildirStore } from './maildir-store';
import { createEmlContent } from './mailfile';
import {
    applyFlagsFromFilename,
    createUniqueMessageId,
    getMailIDfromFileName,
    getStandardMailboxFlags,
    parseFlagsFromFilename,
    rebuildFlagsSuffix,
} from './mailutils';
import { draftToOutboundMail } from './sender';
import { buildMailEvent } from './sse-events';
import { welcomeMail } from './welcome';

function canonicalMailbox(name: string): string {
    if (name === '' || name.toLowerCase() === 'inbox') return '';
    return STANDARD_MAILBOXES.find((m) => m.toLowerCase() === name.toLowerCase()) ?? name;
}

export default class Maildir {
    private store: MaildirStore;
    private db!: MailDB;
    private syncingMailboxes = new Map<string, Promise<void>>();

    constructor(private home: Home) {
        this.store = new MaildirStore(home.homeDir);
    }

    private emit(type: Parameters<typeof buildMailEvent>[0], mail: Parameters<typeof buildMailEvent>[1]): void {
        this.home.broadcast(buildMailEvent(type, mail));
    }

    async init() {
        const isNew = !(await this.store.exists());
        if (isNew) {
            await this.store.createStandardMailboxes();
        }
        this.db = new MailDB(this.home);
        await this.db.init();
        if (isNew) {
            await this.mailboxDeliver(welcomeMail(this.home.user.name, this.home.user.email));
        }
        this.store.watchMailboxes((mailbox) => this.syncMailbox(mailbox));
    }

    async size(): Promise<number> {
        return (await this.store.dirSize()) || this.db.size();
    }

    // -- Mailbox operations --

    async mailboxesList(): Promise<MaildirMailbox[]> {
        const mailboxes: MaildirMailbox[] = [];
        for (const name of STANDARD_MAILBOXES) {
            if (await this.store.mailboxDirExists(name)) {
                mailboxes.push(this.getMailboxInfo(name));
            }
        }
        return mailboxes;
    }

    async mailboxCreate(mailbox: string): Promise<void> {
        if (await this.store.mailboxDirExists(mailbox)) {
            throw new ApiError(409, `Mailbox '${mailbox}' already exists`);
        }
        await this.store.createMailboxDir(mailbox);
    }

    async mailboxExists(mailbox: string): Promise<MaildirMailbox | false> {
        if (!(await this.store.mailboxDirExists(mailbox))) return false;
        return this.getMailboxInfo(mailbox);
    }

    async mailboxDeliver(message: string): Promise<string> {
        const { uniqueId } = await this.store.deliverAtomic(message, '');
        await this.syncMailbox('');
        return uniqueId;
    }

    async mailboxGet(mailbox: string): Promise<EmailSummary[]> {
        mailbox = canonicalMailbox(mailbox);
        if (!(await this.store.mailboxDirExists(mailbox))) {
            throw new ApiError(404, `Mailbox '${mailbox}' not found`);
        }
        await this.syncMailbox(mailbox);
        return this.db.getAllEmails(mailbox);
    }

    // -- Message operations --

    async messageGet(messageId: string): Promise<Email | null> {
        try {
            const cached = this.db.getEmail(messageId);
            if (!cached) return null;

            const parsed = await this.readAndParse(messageId, cached.mailbox, cached.filename);
            if (!parsed) return null;

            for (const a of parsed.attachments) {
                a.content = Buffer.alloc(0);
            }

            applyFlagsFromFilename(parsed, cached.filename);
            return { ...parsed, ...cached } as Email;
        } catch {
            return null;
        }
    }

    async messageGetFile(messageId: string): Promise<ArrayBuffer> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Email '${messageId}' not found`);
        return this.store.readMessageBuffer(email.mailbox, email.filename);
    }

    async messageGetAttachment(messageId: string, index: number) {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        const parsed = await this.readAndParse(messageId, email.mailbox, email.filename);
        if (!parsed?.attachments || index >= parsed.attachments.length) {
            throw new ApiError(404, `Attachment ${index} not found for message '${messageId}'`);
        }

        return parsed.attachments[index];
    }

    async messageDelete(messageId: string): Promise<void> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        await this.store.deleteMessage(email.mailbox, email.filename);
        this.db.deleteEmail(messageId);

        this.emit(SSEventType.MAIL_DELETED, { messageId, mailbox: email.mailbox });
    }

    async messageMove(messageId: string, targetMailbox: string): Promise<void> {
        targetMailbox = canonicalMailbox(targetMailbox);
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        if (!(await this.store.mailboxDirExists(targetMailbox))) {
            throw new ApiError(404, `Target mailbox '${targetMailbox}' not found`);
        }

        const sourceMailbox = email.mailbox;
        await this.store.moveMessage(sourceMailbox, email.filename, targetMailbox);
        this.db.moveEmail(messageId, targetMailbox);

        this.emit(SSEventType.MAIL_MOVED, { messageId, mailbox: sourceMailbox, toMailbox: targetMailbox });
    }

    async messageCopy(messageId: string, targetMailbox: string): Promise<void> {
        targetMailbox = canonicalMailbox(targetMailbox);
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        if (!(await this.store.mailboxDirExists(targetMailbox))) {
            throw new ApiError(404, `Target mailbox '${targetMailbox}' not found`);
        }

        const text = await this.store.readMessageText(email.mailbox, email.filename);
        await this.store.deliverAtomic(text, targetMailbox);
        await this.syncMailbox(targetMailbox);
    }

    async messageSetRead(messageId: string, read: boolean): Promise<void> {
        await this.renameFlag(messageId, { seen: read }, SSEventType.MAIL_READ_CHANGED);
        this.db.setRead(messageId, read);
    }

    async messageSetFlagged(messageId: string, flagged: boolean): Promise<void> {
        await this.renameFlag(messageId, { flagged }, SSEventType.MAIL_FLAGS_CHANGED);
        this.db.setFlagged(messageId, flagged);
    }

    private async renameFlag(
        messageId: string,
        changes: Parameters<typeof rebuildFlagsSuffix>[1],
        eventType: Parameters<typeof buildMailEvent>[0],
    ): Promise<void> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        const newFlagStr = rebuildFlagsSuffix(email.filename, changes);
        const uniqueWithSize = email.filename.split(':')[0];
        const newFilename = `${uniqueWithSize}:2,${newFlagStr}`;

        if (newFilename !== email.filename) {
            await this.store.renameInCur(email.mailbox, email.filename, newFilename);
            this.db.setFilename(messageId, newFilename);
        }

        this.emit(eventType, { messageId, mailbox: email.mailbox });
    }

    // -- Draft & Send --

    async messageHandleDraft(email: EmailDraft): Promise<EmailDraft> {
        const isNew = (email.id || '').trim() === '';
        const user = this.home.user;

        // Delete old draft if updating
        if (!isNew) {
            const old = this.db.getEmail(email.id);
            if (old) {
                await this.store.deleteMessage(old.mailbox, old.filename);
                this.db.deleteEmail(email.id);
            }
        }

        email.from = {
            value: [{ address: user.email, name: user.name }],
            html: user.email,
            text: user.email,
        };

        const emlContent = createEmlContent({
            id: isNew ? createUniqueMessageId() : email.id,
            subject: email.subject || '',
            from: email.from,
            to: email.to,
            cc: email.cc,
            bcc: email.bcc,
            text: email.text || '',
            html: email.html || '',
            date: new Date(),
        });

        const { uniqueId, filename } = await this.store.deliverToCur(
            'Drafts',
            emlContent,
            {
                draft: true,
                seen: true,
            },
            isNew ? undefined : email.id,
        );

        const parsed = await this.readAndParse(uniqueId, 'Drafts', filename);
        if (!parsed) throw new Error(`Failed to parse draft message: ${uniqueId}`);

        applyFlagsFromFilename(parsed, filename);
        parsed.filename = filename;
        parsed.mailbox = 'Drafts';
        this.db.addEmail(parsed as EmailSummary);

        this.emit(SSEventType.MAIL_DRAFT_UPDATED, { messageId: uniqueId, mailbox: 'Drafts' });

        return parsed as EmailDraft;
    }

    async messageSend(mailToSend: EmailDraft): Promise<EmailDraft | null> {
        const mail = await this.messageHandleDraft(mailToSend);
        const message = draftToOutboundMail(mail, this.home.user.email);

        if (!message.subject.trim() && !message.text.trim() && !message.html) {
            throw new ApiError(400, 'Cannot send email with empty subject and body');
        }

        try {
            const sent = await sendMail(message);

            if (sent) {
                await this.messageMove(mail.id, 'Sent');
                await this.renameFlag(mail.id, { draft: false }, SSEventType.MAIL_FLAGS_CHANGED);
                this.db.setDraft(mail.id, false);
                this.emit(SSEventType.MAIL_SENT, { messageId: mail.id, mailbox: 'Sent' });
            }
        } catch (error) {
            console.error('Error sending email:', error);
            return null;
        }
        return mail;
    }

    // -- Sync --

    async syncMailbox(mailbox: string): Promise<void> {
        const running = this.syncingMailboxes.get(mailbox);
        if (running) return running;

        const promise = this.doSyncMailbox(mailbox);
        this.syncingMailboxes.set(mailbox, promise);
        try {
            await promise;
        } finally {
            this.syncingMailboxes.delete(mailbox);
        }
    }

    private async doSyncMailbox(mailbox: string): Promise<void> {
        // Phase 1: Move new/ → cur/
        await this.store.moveNewToCur(mailbox);

        // Phase 2: Build disk state from cur/
        const diskFiles = new Map<string, string>();
        for (const fileName of await this.store.listCurFiles(mailbox)) {
            if (!fileName.startsWith('.')) {
                diskFiles.set(getMailIDfromFileName(fileName), fileName);
            }
        }

        // Phase 3: Get DB state
        const dbRecords = this.db.getAllEmails(mailbox);
        const dbById = new Map(dbRecords.map((r) => [r.id, r]));

        // New messages (on disk but not in DB)
        for (const [id, fileName] of diskFiles) {
            if (!dbById.has(id)) {
                try {
                    const { content, size } = await this.store.readMessage(mailbox, fileName);
                    const parsed = await parseEml(id, mailbox, content, size);
                    if (parsed) {
                        applyFlagsFromFilename(parsed, fileName);
                        parsed.filename = fileName;
                        this.db.addEmail(parsed as EmailSummary);
                        this.emit(SSEventType.MAIL_RECEIVED, { messageId: id, mailbox });
                        if (parsed.fromShort) {
                            const fromEmail = parsed.from?.value?.[0]?.address ?? null;
                            this.home.notifications?.persist({
                                type: 'mail',
                                actorEmail: fromEmail,
                                title: 'New email',
                                body: parsed.subject
                                    ? `From ${parsed.fromShort}: ${parsed.subject}`
                                    : `New email from ${parsed.fromShort}`,
                                tag: `mail:${id}`,
                            });
                        }
                    }
                } catch (e: unknown) {
                    if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT'))
                        console.warn(`syncMailbox: failed to parse ${fileName}:`, e instanceof Error ? e.message : e);
                }
            }
        }

        // Flag changes (on disk with different filename)
        for (const [id, record] of dbById) {
            const diskFilename = diskFiles.get(id);
            if (diskFilename && diskFilename !== record.filename) {
                const flags = parseFlagsFromFilename(diskFilename);
                this.db.updateFlags(
                    id,
                    {
                        isRead: flags.seen,
                        isFlagged: flags.flagged,
                        isDraft: flags.draft,
                        isReplied: flags.replied,
                    },
                    diskFilename,
                );
                this.emit(SSEventType.MAIL_FLAGS_CHANGED, { messageId: id, mailbox });
            }
        }

        // Deleted messages (in DB but not on disk)
        for (const [id] of dbById) {
            if (!diskFiles.has(id)) {
                this.db.deleteEmail(id);
                this.emit(SSEventType.MAIL_DELETED, { messageId: id, mailbox });
            }
        }
    }

    // -- Private helpers --

    private async readAndParse(messageId: string, mailbox: string, filename?: string): Promise<Email | null> {
        try {
            if (!filename) {
                const record = this.db.getEmail(messageId);
                filename = record?.filename;
            }
            if (!filename) {
                console.warn(`readAndParse: filename not in DB for ${messageId}, scanning disk`);
                filename = await this.store.findFileByUniqueId(messageId, mailbox);
            }
            if (!filename) return null;

            const { content, size } = await this.store.readMessage(mailbox, filename);
            return parseEml(messageId, mailbox, content, size);
        } catch {
            return null;
        }
    }

    private getMailboxInfo(mailboxName: string): MaildirMailbox {
        const flags = getStandardMailboxFlags(mailboxName);
        if (!mailboxName && !flags.includes('\\Inbox')) {
            flags.push('\\Inbox');
        }

        return {
            path: mailboxName,
            name: mailboxName ? mailboxName.split('.').pop() || mailboxName : 'INBOX',
            delimiter: '.',
            flags,
            total: this.db.getEmailsCount(mailboxName),
            unread: this.db.getEmailsCountUnread(mailboxName),
        };
    }

    async destruct(): Promise<void> {
        this.store.unwatchMailboxes();
        if (this.db) {
            await this.db.destruct();
        }
    }
}
