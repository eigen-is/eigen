import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type {
    AddressObject,
    Attachment,
    DraftAttachmentUpload,
    Email,
    EmailDraft,
    EmailSummary,
    MaildirMailbox,
    NewDraft,
} from '@workspace/lib/types/mail';
import { SSEventType } from '@workspace/lib/types/sse';
import { ApiError, STANDARD_MAILBOXES } from '../core';
import type { Home } from '../home';
import type { StorageFile } from '../storage';
import type { DraftUpdateOptions, MailSearchOptions, MailStore } from './mail-store';
import { buildMailEvent } from './sse-events';
import { welcomeMail } from './welcome';

export type DraftMeta = {
    subject: string;
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
    text: string;
    // "Clean" body as typed by the user — without the reference-card HTML that the EML
    // on disk has baked in. Overlaid on messageGet so the compose view shows what the
    // user typed, not the rendered card block at the bottom.
    html: string;
    attachments: Array<{ filename: string; contentType: string; size: number }>;
    driveReferences?: AttachmentReference[];
    lastFullSaveAt?: number;
};

function canonicalMailbox(name: string): string {
    if (name === '' || name.toLowerCase() === 'inbox') return '';
    return STANDARD_MAILBOXES.find((m) => m.toLowerCase() === name.toLowerCase()) ?? name;
}

export class Mail {
    constructor(
        private home: Home,
        private store: MailStore,
    ) {}

    private emit(type: Parameters<typeof buildMailEvent>[0], mail: Parameters<typeof buildMailEvent>[1]): void {
        this.home.broadcast(buildMailEvent(type, mail));
    }

    async init(): Promise<void> {
        const isNew = await this.store.init({
            received: (email, isNewMessage) => {
                this.emit(SSEventType.MAIL_RECEIVED, { messageId: email.id, mailbox: email.mailbox });
                if (isNewMessage && email.fromShort) {
                    this.home.notifications?.persist({
                        type: 'mail',
                        actorEmail: email.from?.value?.[0]?.address ?? null,
                        title: 'New email',
                        body: email.subject
                            ? `From ${email.fromShort}: ${email.subject}`
                            : `New email from ${email.fromShort}`,
                        tag: 'mail:new',
                    });
                }
            },
            flagsChanged: (messageId, mailbox) => this.emit(SSEventType.MAIL_FLAGS_CHANGED, { messageId, mailbox }),
            deleted: (messageId, mailbox) => this.emit(SSEventType.MAIL_DELETED, { messageId, mailbox }),
        });
        if (isNew) {
            const welcome = await welcomeMail(this.home.user.name, this.home.user.email);
            if (welcome) await this.store.append('', welcome, { skipSync: true });
        }
        this.store.watch();
        this.store.cleanupStaleDraftTemps().catch((err) => console.error('mail: stale draft temp cleanup failed', err));
    }

    async size(): Promise<number> {
        return this.store.size();
    }

    search(opts: MailSearchOptions): EmailSummary[] {
        // Canonicalise mailbox names here so callers can pass any case (e.g. `trash`,
        // `Trash`, `inbox`) and the FTS mailbox filter matches the stored value exactly.
        const mailboxes = opts.mailboxes?.map(canonicalMailbox);
        return this.store.search({ ...opts, mailboxes });
    }

    // -- Mailbox operations --

    async mailboxesList(): Promise<MaildirMailbox[]> {
        return this.store.mailboxesList();
    }

    async mailboxCreate(mailbox: string): Promise<void> {
        return this.store.mailboxCreate(mailbox);
    }

    async mailboxExists(mailbox: string): Promise<MaildirMailbox | false> {
        return this.store.mailboxExists(mailbox);
    }

    async mailboxDeliver(message: Buffer): Promise<string> {
        return this.store.append('', message);
    }

    async mailboxGet(mailbox: string): Promise<EmailSummary[]> {
        return this.store.listMessages(canonicalMailbox(mailbox));
    }

    // -- Message operations --

    async messageGet(messageId: string): Promise<Email | null> {
        // null means "not found" ONLY: no summary row (real cache-miss) or the .eml isn't
        // locatable. A parse/read/DB fault propagates → Elysia 500 + log, never a silent 404.
        const message = await this.store.getMessage(messageId);
        if (!message) return null;

        for (const a of message.attachments) {
            a.content = Buffer.alloc(0);
        }

        // Overlay latest values from draft-meta sidecar (written by fast-path saves).
        // Sidecar values win over both the stale EML and the summary row.
        if (message.isDraft) {
            const meta = await this.store.readDraftMeta<DraftMeta>(messageId);
            if (meta) {
                message.subject = meta.subject;
                message.html = meta.html;
                message.text = meta.text;
                if (meta.to) message.to = meta.to;
                if (meta.cc) message.cc = meta.cc;
                if (meta.bcc) message.bcc = meta.bcc;
                message.driveReferences = meta.driveReferences ?? [];
            }
        }

        return message;
    }

    async messageGetFile(messageId: string): Promise<ArrayBuffer> {
        return this.store.getRawMessage(messageId);
    }

    async messageGetAttachment(messageId: string, index: number): Promise<Attachment> {
        const attachments = await this.store.getAttachments(messageId);
        if (index >= attachments.length) {
            throw new ApiError(404, `Attachment ${index} not found for message '${messageId}'`);
        }
        return attachments[index];
    }

    async messageGetAttachments(messageId: string): Promise<Attachment[]> {
        return this.store.getAttachments(messageId);
    }

    async messageDelete(messageId: string): Promise<void> {
        const email = this.store.getSummary(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        await this.store.delete(messageId);
        await this.store.deleteDraftMeta(messageId);

        this.emit(SSEventType.MAIL_DELETED, { messageId, mailbox: email.mailbox });
    }

    async messageMove(messageId: string, targetMailbox: string): Promise<void> {
        targetMailbox = canonicalMailbox(targetMailbox);
        const email = this.store.getSummary(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        await this.store.move(messageId, targetMailbox);

        this.emit(SSEventType.MAIL_MOVED, { messageId, mailbox: email.mailbox, toMailbox: targetMailbox });
    }

    async messageCopy(messageId: string, targetMailbox: string): Promise<void> {
        targetMailbox = canonicalMailbox(targetMailbox);
        if (!this.store.getSummary(messageId)) {
            throw new ApiError(404, `Message '${messageId}' not found`);
        }
        if (!(await this.store.mailboxExists(targetMailbox))) {
            throw new ApiError(404, `Target mailbox '${targetMailbox}' not found`);
        }

        // Copy the raw bytes, not a `.text()` round-trip — decoding would corrupt non-UTF-8 mail.
        const bytes = Buffer.from(await this.store.getRawMessage(messageId));
        await this.store.append(targetMailbox, bytes);
    }

    async messageSetRead(messageId: string, read: boolean): Promise<void> {
        const email = this.store.getSummary(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        await this.store.setFlags(messageId, { seen: read });
        this.emit(SSEventType.MAIL_READ_CHANGED, { messageId, mailbox: email.mailbox });
    }

    async messageSetFlagged(messageId: string, flagged: boolean): Promise<void> {
        const email = this.store.getSummary(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        await this.store.setFlags(messageId, { flagged });
        this.emit(SSEventType.MAIL_FLAGS_CHANGED, { messageId, mailbox: email.mailbox });
    }

    // -- Draft & Send --

    async messageHandleDraft(email: NewDraft | EmailDraft, options: DraftUpdateOptions = {}): Promise<EmailDraft> {
        return this.store.messageHandleDraft(email, options);
    }

    async uploadDraftAttachment(request: Request, maxSize: number): Promise<DraftAttachmentUpload> {
        return this.store.uploadDraftAttachment(request, maxSize);
    }

    async stageDriveAttachment(
        source: StorageFile,
        filename: string,
        contentType: string,
        maxSize: number,
    ): Promise<DraftAttachmentUpload> {
        return this.store.stageDriveAttachment(source, filename, contentType, maxSize);
    }

    async messageSend(mail: NewDraft | EmailDraft): Promise<EmailDraft> {
        return this.store.messageSend(mail);
    }

    async destruct(): Promise<void> {
        await this.store.unwatch();
        return this.store.destruct();
    }
}
