// Mail is the mail part of a user's Home: the inbox, folders, drafts and sending, as the mail routes
// and the mail app use them. It keeps the messages in a mail store and turns the changes the store
// discovers, such as new mail arriving, into live updates and notifications for the user.

import { canonicalMailbox, MAILBOX_DRAFTS, MAILBOX_INBOX, MAILBOX_SENT } from '@workspace/lib/constants/mailboxes';
import type {
    Attachment,
    DraftAttachmentUpload,
    DraftUpdateOptions,
    Email,
    EmailDraft,
    EmailSummary,
    ImportMailResult,
    MaildirMailbox,
    NewDraft,
    SentMailResult,
} from '@workspace/lib/types/mail';
import { isCalendarPart, isEmailDraft, mailAttachmentName } from '@workspace/lib/types/mail';
import type { SSEventMail } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { processInboundImip, summarizeCalendarInvite } from '../calendar/imip';
import { enforceHomeDataQuota } from '../config/enforcement';
import { isDemo, isMailAppEnabled } from '../config/env';
import { getMailDomain, isInternalAddress } from '../config/server-config';
import { ApiError, isSafePathSegment, NOT_AN_EMAIL_FILE } from '../core';
import type { Home } from '../home';
import { renderAttachmentLinksText } from '../mailer/mail-template';
import type { OutboundMail } from '../mailer/mailer';
import { sendMail } from '../mailer/mailer';
import { MaxFileSizeExceededError, parseMultipartRequest } from '../multipart';
import type { StorageFile } from '../storage';
import { streamStorageFile } from '../storage';
import { grantAccessForReferences } from './access-grants';
import { verifyImipSender } from './imip-auth';
import type { PartHeaders } from './mail-parser';
import { parseMail, splitMime } from './mail-parser';
import type { MailSearchOptions } from './mail-store';
import type { MaildirStore } from './maildir-store';
import type { EmlAttachment } from './mailfile';
import { createEmlContent } from './mailfile';
import { createUniqueMessageId } from './mailutils';
import { MAX_PERSONALISED_SEND_BYTES } from './recipients';
import { appendDraftReferences, appendReferenceLinks } from './reference-links';
import { draftToOutboundMail } from './sender';
import { buildMailEvent } from './sse-events';
import { welcomeMail } from './welcome';

const MAIL_NOTIFICATION_TAG = 'mail:new';

// A blank id normalizes to undefined, so `?? createUniqueMessageId()` bakes a `Message-ID: <@domain>` into the EML.
// Folded to NFC first, the rule `isSafePathSegment` is written for: one spelling reaches the filesystem.
function draftIdOf(email: NewDraft): string | undefined {
    const id = email.id?.trim().normalize('NFC') || undefined;
    if (id && !isSafePathSegment(id)) throw new ApiError(400, `Invalid draft id: ${id}`);
    return id;
}

export function attachmentTooLarge(maxSize: number): ApiError {
    return new ApiError(413, `Attachment exceeds ${Math.floor(maxSize / (1024 * 1024))}MB limit`);
}

// An answer to the browser names a part and its size. The bytes come from the part's own route: as JSON they are about
// 3.5 times their size, and the browser's query cache keeps the answer.
function blankAttachmentBytes<T extends Pick<Email, 'attachments'>>(email: T): T {
    for (const a of email.attachments) a.content = Buffer.alloc(0);
    return email;
}

export class Mail {
    public constructor(
        public readonly home: Home,
        private store: MaildirStore,
    ) {}

    private emit(type: SSEventMail['type'], mail: SSEventMail['mail']): void {
        this.home.broadcast(buildMailEvent(type, mail));
    }

    private readNotificationOnceInboxRead(): void {
        if (this.store.unreadCount(MAILBOX_INBOX) === 0) this.home.notifications.markReadByTag(MAIL_NOTIFICATION_TAG);
    }

    public async init(): Promise<void> {
        const isNew = await this.store.init({
            received: (email, isNewMessage) => {
                this.emit(SSEventType.MAIL_RECEIVED, { messageId: email.id, mailbox: email.mailbox });
                if (isNewMessage && email.fromShort) {
                    this.home.notifications.persist({
                        type: 'mail',
                        actorEmail: email.from?.value?.[0]?.address ?? null,
                        title: `New mail from ${email.fromShort}`,
                        body: email.subject || '(no subject)',
                        tag: MAIL_NOTIFICATION_TAG,
                        coalesce: true,
                        details: {
                            mailId: email.id,
                            snippet: email.textShort ? email.textShort.slice(0, 120) : undefined,
                        },
                    });
                }
            },
            flagsChanged: (messageId, mailbox) => {
                this.emit(SSEventType.MAIL_FLAGS_CHANGED, { messageId, mailbox });
                this.readNotificationOnceInboxRead();
            },
            deleted: (messageId, mailbox) => {
                this.emit(SSEventType.MAIL_DELETED, { messageId, mailbox });
                this.readNotificationOnceInboxRead();
            },
        });
        // Every user Home has a Mail, and with mail off it seeds and cleans nothing. Its folder watchers start
        // only when somebody has the home open in a tab (watchFolders).
        if (!isMailAppEnabled()) return;
        if (isNew) {
            const welcome = await welcomeMail(this.home.user.name, this.home.user.email);
            // Seeded, not delivered: the first sync indexes it without announcing new mail.
            if (welcome) await this.store.append(MAILBOX_INBOX, welcome, { skipReconcile: true, arrival: false });
        }
        this.store.cleanupStaleDraftTemps().catch((err) => console.error('mail: stale draft temp cleanup failed', err));
    }

    public async size(): Promise<number> {
        return this.store.size();
    }

    public search(opts: MailSearchOptions): EmailSummary[] {
        if (!isMailAppEnabled()) return [];
        // The FTS mailbox filter matches the stored value exactly, so any caller casing is canonicalised first.
        const mailboxes = opts.mailboxes?.map(canonicalMailbox);
        return this.store.search({ ...opts, mailboxes });
    }

    // -- Mailbox operations --

    public async mailboxesList(): Promise<MaildirMailbox[]> {
        return this.store.mailboxesList();
    }

    public async mailboxDeliver(message: Buffer): Promise<string> {
        const uniqueId = await this.store.append(MAILBOX_INBOX, message);

        // Process iMIP calendar attachments (blocking so event exists before client queries)
        try {
            const parsed = parseMail(message);
            const hasCalendar = parsed.attachments.some(isCalendarPart);
            if (hasCalendar) {
                // Delivered mail alone carries our own MTA's verdict, so the calendar's verdict is computed here only.
                const from = parsed.from?.value?.[0]?.address?.toLowerCase() ?? null;
                const verdict = verifyImipSender(
                    parsed.authenticationResults,
                    getMailDomain(),
                    from?.split('@')[1] ?? null,
                );
                await processInboundImip(this.home, parsed, verdict);
            }
        } catch (error) {
            console.error('iMIP processing failed:', error);
        }

        return uniqueId;
    }

    // No processInboundImip: an imported file carries no DKIM verdict, so it must never touch the calendar.
    public async messageImport(bytes: Buffer): Promise<ImportMailResult> {
        // The sync after the append parses the message anyway, so only the headers are split here.
        let headers: PartHeaders;
        try {
            headers = splitMime(bytes).headers;
        } catch {
            throw new ApiError(400, NOT_AN_EMAIL_FILE);
        }
        // Any bytes parse as a body. Only an envelope header makes them a message.
        if (!headers.from && !headers.date && headers.subject === undefined && !headers.messageId) {
            throw new ApiError(400, NOT_AN_EMAIL_FILE);
        }
        await enforceHomeDataQuota(this.home.user.id, bytes.byteLength);

        const id = await this.store.append(MAILBOX_INBOX, bytes, { arrival: false });
        return { id };
    }

    public async mailboxGet(
        mailbox: string,
        opts?: { limit?: number; beforeDate?: number; beforeId?: string },
    ): Promise<EmailSummary[]> {
        const limit = opts?.limit ?? 200;
        const before =
            opts?.beforeDate != null && opts?.beforeId != null
                ? { date: new Date(opts.beforeDate), id: opts.beforeId }
                : undefined;
        return this.store.listMessages(canonicalMailbox(mailbox), { limit, before });
    }

    // -- Message operations --

    public async messageGet(messageId: string): Promise<Email | null> {
        // null means "no summary row" only: a parse, read or DB fault propagates to a 500, never a silent 404.
        const message = await this.store.getMessage(messageId);
        if (!message) return null;

        // Summarize invite parts while the parsed content is still in memory, then blank it.
        for (const a of message.attachments) {
            if (isCalendarPart(a)) {
                a.calendarInvite = summarizeCalendarInvite(a);
            }
        }
        blankAttachmentBytes(message);

        return message;
    }

    public async messageGetFile(messageId: string): Promise<ArrayBuffer> {
        return this.store.getRawMessage(messageId);
    }

    public messageGetSummary(messageId: string): EmailSummary | undefined {
        return this.store.getSummary(messageId);
    }

    public async messageGetAttachment(messageId: string, index: number): Promise<Attachment> {
        const attachments = await this.store.getAttachments(messageId);
        if (index < 0 || index >= attachments.length) {
            throw new ApiError(404, `Attachment ${index} not found for message '${messageId}'`);
        }
        return attachments[index];
    }

    public async messageGetAttachments(messageId: string): Promise<Attachment[]> {
        return this.store.getAttachments(messageId);
    }

    public async messageDelete(messageId: string): Promise<void> {
        const email = this.store.getSummary(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        await this.store.delete(messageId);

        this.emit(SSEventType.MAIL_DELETED, { messageId, mailbox: email.mailbox });
        this.readNotificationOnceInboxRead();
    }

    public async messageMove(messageId: string, targetMailbox: string): Promise<void> {
        targetMailbox = canonicalMailbox(targetMailbox);
        const email = this.store.getSummary(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        await this.store.move(messageId, targetMailbox);

        this.emit(SSEventType.MAIL_MOVED, { messageId, mailbox: email.mailbox, toMailbox: targetMailbox });
        this.readNotificationOnceInboxRead();
    }

    public async messageCopy(messageId: string, targetMailbox: string): Promise<void> {
        targetMailbox = canonicalMailbox(targetMailbox);
        if (!this.store.getSummary(messageId)) {
            throw new ApiError(404, `Message '${messageId}' not found`);
        }
        if (!(await this.store.mailboxExists(targetMailbox))) {
            throw new ApiError(404, `Target mailbox '${targetMailbox}' not found`);
        }

        // Raw bytes, not a `.text()` round-trip: decoding corrupts non-UTF-8 mail, and a copy is not mail arriving.
        const bytes = Buffer.from(await this.store.getRawMessage(messageId));
        await this.store.append(targetMailbox, bytes, { arrival: false });
    }

    public async messageSetRead(messageId: string, read: boolean): Promise<void> {
        const email = this.store.getSummary(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        await this.store.setFlags(messageId, { seen: read });
        this.emit(SSEventType.MAIL_READ_CHANGED, { messageId, mailbox: email.mailbox });
        this.readNotificationOnceInboxRead();
    }

    public async messageSetFlagged(messageId: string, flagged: boolean): Promise<void> {
        const email = this.store.getSummary(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        await this.store.setFlags(messageId, { flagged });
        this.emit(SSEventType.MAIL_FLAGS_CHANGED, { messageId, mailbox: email.mailbox });
    }

    public async messageSetReplied(messageId: string): Promise<void> {
        const email = this.store.getSummary(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);
        await this.markReplied(messageId, email.mailbox);
    }

    private async markReplied(messageId: string, mailbox: string): Promise<void> {
        await this.store.setFlags(messageId, { replied: true });
        this.emit(SSEventType.MAIL_FLAGS_CHANGED, { messageId, mailbox });
    }

    // -- Draft & Send --

    public async messageHandleDraft(email: NewDraft, options: DraftUpdateOptions = {}): Promise<EmailDraft> {
        return blankAttachmentBytes(await this.writeDraft(email, options));
    }

    // The request is the whole draft: a field it leaves out is cleared. Only the attachments live on the server alone,
    // so it names the parts to keep.
    private async writeDraft(email: NewDraft, options: DraftUpdateOptions): Promise<EmailDraft> {
        const user = this.home.user;
        const existingId = draftIdOf(email);

        const attachments: EmlAttachment[] = [];
        // No row means an IMAP client replaced this draft under another id. This save writes the old id again, and the
        // user sees two drafts with neither lost.
        if (existingId && this.store.getSummary(existingId)) {
            const keepSet = options.keepAttachmentIndexes ? new Set(options.keepAttachmentIndexes) : null;
            for (const a of await this.store.getAttachments(existingId)) {
                if (keepSet && !keepSet.has(a.index)) continue;
                attachments.push({
                    filename: mailAttachmentName(a, a.index),
                    content: Buffer.from(a.content),
                    contentType: a.contentType,
                });
            }
        }
        for (const tempId of options.tempAttachmentIds ?? []) {
            const temp = await this.store.readDraftTempFile(tempId);
            if (!temp) throw new ApiError(404, `Temp attachment '${tempId}' not found`);
            attachments.push({ filename: temp.filename, content: temp.content, contentType: temp.contentType });
        }

        const newId = existingId ?? createUniqueMessageId();
        const cleanHtml = email.html || '';
        const driveReferences = email.driveReferences ?? [];
        const emlContent = await createEmlContent({
            id: newId,
            subject: email.subject || '',
            from: { value: [{ address: user.email, name: user.name }], text: user.email },
            to: email.to,
            cc: email.cc,
            bcc: email.bcc,
            // MailComposer leaves an empty text part out, and the parser would then derive the text from the pills.
            text: email.text || ' ',
            html: appendDraftReferences(cleanHtml, driveReferences),
            date: new Date(),
            inReplyTo: email.inReplyTo,
            references: email.references,
            repliedToId: email.repliedToId,
            attachments,
        });

        // Persist under the id baked into the EML header: a minted id leaves the wire Message-ID out of sync with the Sent EML.
        const saved = await this.store.saveDraft(emlContent, newId);
        // saveDraft always writes the D flag. The guard carries that rule into the type.
        if (!isEmailDraft(saved)) throw new Error(`Draft '${saved.id}' was saved without the draft flag`);

        for (const tempId of options.tempAttachmentIds ?? []) {
            await this.store.cleanupDraftTemp(tempId);
        }

        this.emit(SSEventType.MAIL_DRAFT_UPDATED, { messageId: saved.id, mailbox: MAILBOX_DRAFTS });

        // What the composer sent, not the file's copy of it: the file's holds the pills, which a send draws afresh.
        saved.html = cleanHtml;
        saved.text = email.text || '';
        saved.driveReferences = driveReferences;
        return saved;
    }

    public async uploadDraftAttachment(request: Request, maxSize: number): Promise<DraftAttachmentUpload> {
        try {
            const events = parseMultipartRequest(request, { maxFileSize: maxSize });
            for await (const event of events) {
                if (event.type !== 'part' || !event.filename) continue;
                return await this.store.persistDraftTemp(
                    async (writer) => {
                        // Advances the same generator: drains this part's body, then stops.
                        for await (const next of events) {
                            if (next.type === 'chunk') writer.write(next.data);
                            else if (next.type === 'end') return next.size;
                        }
                        return 0; // unreachable: the parser emits 'end' or throws
                    },
                    event.filename,
                    event.mediaType || 'application/octet-stream',
                );
            }
        } catch (e) {
            if (e instanceof MaxFileSizeExceededError) throw attachmentTooLarge(maxSize);
            throw e;
        }

        throw new ApiError(400, 'No file in request');
    }

    public async stageDriveAttachment(
        source: StorageFile,
        filename: string,
        contentType: string,
        maxSize: number,
    ): Promise<DraftAttachmentUpload> {
        // The route already checked the drive size, so the cap is only for a source that grows mid-read.
        return this.store.persistDraftTemp(
            (writer) => {
                let size = 0;
                return streamStorageFile(source, (chunk) => {
                    size += chunk.byteLength;
                    if (size > maxSize) throw attachmentTooLarge(maxSize);
                    writer.write(chunk);
                });
            },
            filename,
            contentType,
        );
    }

    public async messageSend(
        mailToSend: NewDraft,
        options?: { grantAccessRefIds?: string[] },
    ): Promise<SentMailResult> {
        // The save hands back the parts' bytes for SMTP, and From pinned to the account.
        const mail = await this.writeDraft(mailToSend, {});
        const message = draftToOutboundMail(mail, this.home.user.email);
        const allRecipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];

        // Pre-bake bodies: an external copy personalises its links off this base, the internal copy bakes bare ones.
        const refs = mail.driveReferences ?? [];
        const baseHtml = message.html || '';
        const baseText = message.text;

        // Links count as content, so a ref-only send is legitimate and only an empty subject, body and ref list is refused.
        if (!message.subject.trim() && !message.text.trim() && !message.html && !refs.length) {
            throw new ApiError(400, 'Cannot send email with empty subject and body');
        }
        if (!allRecipients.length) throw new ApiError(400, 'Add at least one recipient');

        // A demo box has no MTA: fail loudly rather than pretend to send, with the message kept in Drafts.
        if (isDemo()) {
            throw new ApiError(
                403,
                'This is a shared demo, so outgoing email is turned off. Your message is saved in Drafts.',
            );
        }

        // After the demo guard and before delivery, so a failed grant stops the send. Only To and Cc addresses get
        // access.
        if (options?.grantAccessRefIds?.length) {
            await grantAccessForReferences(
                this.home.user,
                refs,
                options.grantAccessRefIds,
                [...message.to, ...(message.cc ?? [])].map((a) => a.address),
            );
        }

        const externals = allRecipients.filter((r) => !isInternalAddress(r.address));
        const failedRecipients: string[] = [];

        // Personalising re-sends every attachment per external recipient, so an unbounded fan-out stalls the MTA and the browser.
        const fanOutBytes =
            externals.length * (message.attachments ?? []).reduce((sum, a) => sum + Buffer.byteLength(a.content), 0);

        if (!refs.length || !externals.length || fanOutBytes > MAX_PERSONALISED_SEND_BYTES) {
            // One send with bare links, no per-recipient envelope.
            message.html = appendReferenceLinks(baseHtml, refs);
            message.text = baseText + renderAttachmentLinksText(refs);
            if (!(await sendMail(message))) {
                throw new ApiError(500, 'Failed to send email');
            }
        } else {
            // One SMTP envelope per external recipient, so a leaked `?email=` link can never reach the wrong person.
            const { bcc: _bcc, ...base } = message;
            const buildCopy = (
                recipientEmail: string | undefined,
                envelopeTo: string[],
            ): OutboundMail & { envelope: NonNullable<OutboundMail['envelope']> } => ({
                ...base,
                html: appendReferenceLinks(baseHtml, refs, recipientEmail),
                text: baseText + renderAttachmentLinksText(refs, recipientEmail),
                envelope: { to: envelopeTo },
            });

            const copies: ReturnType<typeof buildCopy>[] = [];
            const internal = allRecipients.filter((r) => isInternalAddress(r.address)).map((r) => r.address);
            if (internal.length) copies.push(buildCopy(undefined, internal));
            for (const ext of externals) {
                copies.push(buildCopy(ext.address, [ext.address]));
            }

            let anyAccepted = false;
            for (const copy of copies) {
                if (await sendMail(copy)) anyAccepted = true;
                else failedRecipients.push(...copy.envelope.to);
            }
            if (!anyAccepted) {
                throw new ApiError(500, 'Failed to send email');
            }
        }

        await this.messageMove(mail.id, MAILBOX_SENT);
        await this.store.setFlags(mail.id, { draft: false });
        this.emit(SSEventType.MAIL_FLAGS_CHANGED, { messageId: mail.id, mailbox: MAILBOX_SENT });
        this.emit(SSEventType.MAIL_SENT, { messageId: mail.id, mailbox: MAILBOX_SENT });

        // The mail is out: a reply mark that fails to stick must not fail the send, or a retry sends it twice.
        const answered = mail.repliedToId ? this.store.getSummary(mail.repliedToId) : undefined;
        if (answered) {
            await this.markReplied(answered.id, answered.mailbox).catch((err) =>
                console.error('mail: marking the answered message failed', err),
            );
        }

        blankAttachmentBytes(mail);
        return failedRecipients.length ? { ...mail, failedRecipients } : mail;
    }

    // A home opened only to deliver a notification or a share needs no watchers, and on macOS each one
    // blocks the event loop for longer the more the process already holds.
    public async watchFolders(): Promise<void> {
        if (!isMailAppEnabled()) return;
        await this.store.watch();
    }

    public async destruct(): Promise<void> {
        await this.store.unwatch();
        return this.store.destruct();
    }
}
