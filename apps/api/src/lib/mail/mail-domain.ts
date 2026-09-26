import { MAIL_PREVIEW_CHARS, MAX_SEND_REFERENCES } from '@workspace/lib/constants/mail';
import { canonicalMailbox, MAILBOX_DRAFTS, MAILBOX_SENT } from '@workspace/lib/constants/mailboxes';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import {
    type AddressObject,
    type Attachment,
    type DraftAttachmentUpload,
    type DraftUpdateOptions,
    type Email,
    type EmailDraft,
    type EmailSummary,
    type ImportMailResult,
    isCalendarPart,
    isEmailDraft,
    type MaildirMailbox,
    mailAttachmentName,
    type NewDraft,
    type SentMailResult,
} from '@workspace/lib/types/mail';
import { type SSEventMail, SSEventType } from '@workspace/lib/types/sse';
import { processInboundImip, summarizeCalendarInvite } from '../calendar/imip';
import { enforceHomeDataQuota } from '../config/enforcement';
import { isDemo } from '../config/env';
import { getMailDomain, isInternalAddress } from '../config/server-config';
import { ApiError, isSafePathSegment, NOT_AN_EMAIL_FILE } from '../core';
import { renderAttachmentLinksText, renderAttachmentPills } from '../core/mail-template';
import { type OutboundMail, sendMail } from '../core/mailer';
import type { Home } from '../home';
import { MaxFileSizeExceededError, parseMultipartRequest } from '../multipart';
import { consumeStream, getStorageTimeoutMs, type StorageFile } from '../storage';
import { grantAccessForReferences } from './access-grants';
import { verifyImipSender } from './imip-auth';
import { type PartHeaders, parseMail, splitMime } from './mail-parser';
import type { DraftMeta, DraftMetaAttachment, MailSearchOptions, MailStore } from './mail-store';
import { createEmlContent, type EmlAttachment } from './mailfile';
import { createUniqueMessageId } from './mailutils';
import { MAX_PERSONALISED_SEND_BYTES } from './recipients';
import { draftToOutboundMail } from './sender';
import { buildMailEvent } from './sse-events';
import { welcomeMail } from './welcome';

const FULL_SAVE_INTERVAL_MS = 5 * 60 * 1000;

// A blank id normalizes to undefined, so `?? createUniqueMessageId()` bakes a `Message-ID: <@domain>` into the EML.
// Folded to NFC first, the rule `isSafePathSegment` is written for: one spelling reaches the filesystem.
function draftIdOf(email: NewDraft | EmailDraft): string | undefined {
    const id = email.id?.trim().normalize('NFC') || undefined;
    if (id && !isSafePathSegment(id)) throw new ApiError(400, `Invalid draft id: ${id}`);
    return id;
}

export function attachmentTooLarge(maxSize: number): ApiError {
    return new ApiError(413, `Attachment exceeds ${Math.floor(maxSize / (1024 * 1024))}MB limit`);
}

function appendReferenceLinks(html: string, refs: AttachmentReference[], recipientEmail?: string): string {
    const refHtml = renderAttachmentPills(refs, recipientEmail);
    if (!refHtml) return html;
    if (!html) return refHtml;
    const replaced = html.replace(/<\/body>/i, `${refHtml}</body>`);
    return replaced !== html ? replaced : html + refHtml;
}

export class Mail {
    constructor(
        private home: Home,
        private store: MailStore,
    ) {}

    private emit(type: SSEventMail['type'], mail: SSEventMail['mail']): void {
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
                        title: `New mail from ${email.fromShort}`,
                        body: email.subject || '(no subject)',
                        tag: 'mail:new',
                        coalesce: true,
                        details: {
                            mailId: email.id,
                            snippet: email.textShort ? email.textShort.slice(0, 120) : undefined,
                        },
                    });
                }
            },
            flagsChanged: (messageId, mailbox) => this.emit(SSEventType.MAIL_FLAGS_CHANGED, { messageId, mailbox }),
            deleted: (messageId, mailbox) => this.emit(SSEventType.MAIL_DELETED, { messageId, mailbox }),
        });
        if (isNew) {
            const welcome = await welcomeMail(this.home.user.name, this.home.user.email);
            // Seeded, not delivered: the first sync indexes it without announcing new mail.
            if (welcome) await this.store.append('', welcome, { skipReconcile: true, arrival: false });
        }
        await this.store.watch();
        this.store.cleanupStaleDraftTemps().catch((err) => console.error('mail: stale draft temp cleanup failed', err));
    }

    async size(): Promise<number> {
        return this.store.size();
    }

    search(opts: MailSearchOptions): EmailSummary[] {
        // The FTS mailbox filter matches the stored value exactly, so any caller casing is canonicalised first.
        const mailboxes = opts.mailboxes?.map(canonicalMailbox);
        return this.store.search({ ...opts, mailboxes });
    }

    // -- Mailbox operations --

    async mailboxesList(): Promise<MaildirMailbox[]> {
        return this.store.mailboxesList();
    }

    async mailboxCreate(mailbox: string): Promise<void> {
        return this.store.mailboxCreate(canonicalMailbox(mailbox));
    }

    async mailboxExists(mailbox: string): Promise<MaildirMailbox | false> {
        return this.store.mailboxExists(canonicalMailbox(mailbox));
    }

    async mailboxDeliver(message: Buffer): Promise<string> {
        const uniqueId = await this.store.append('', message);

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
    async messageImport(bytes: Buffer): Promise<ImportMailResult> {
        // The sync after the append parses the message anyway, so a full parse here is a second one (103 ms vs 0.05 ms on 1.1 MiB).
        let headers: PartHeaders;
        try {
            headers = splitMime(bytes).headers;
        } catch {
            throw new ApiError(400, NOT_AN_EMAIL_FILE);
        }
        // Any bytes parse as a body; only an envelope header makes them a message.
        if (!headers.from && !headers.date && headers.subject === undefined && !headers.messageId) {
            throw new ApiError(400, NOT_AN_EMAIL_FILE);
        }
        await enforceHomeDataQuota(this.home.user.id, bytes.byteLength);

        const id = await this.store.append('', bytes, { arrival: false });
        return { id };
    }

    async mailboxGet(
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

    async messageGet(messageId: string): Promise<Email | null> {
        // null means "no summary row" only: a parse, read or DB fault propagates to a 500, never a silent 404.
        const message = await this.store.getMessage(messageId);
        if (!message) return null;

        // Summarize invite parts while the parsed content is still in memory, then blank it.
        for (const a of message.attachments) {
            if (isCalendarPart(a)) {
                a.calendarInvite = summarizeCalendarInvite(a);
            }
            a.content = Buffer.alloc(0);
        }

        // A fast-path save leaves the EML stale, so the sidecar wins over both the EML and the summary row.
        if (message.isDraft) {
            const meta = await this.store.readDraftMeta(messageId);
            if (meta) {
                message.subject = meta.subject;
                message.html = meta.html;
                message.text = meta.text;
                // Unconditional: both save paths write the full field set, so an absent one means cleared.
                message.to = meta.to;
                message.cc = meta.cc;
                message.bcc = meta.bcc;
                message.driveReferences = meta.driveReferences ?? [];
            }
        }

        return message;
    }

    async messageGetFile(messageId: string): Promise<ArrayBuffer> {
        return this.store.getRawMessage(messageId);
    }

    // The index row, which serveMailPart validates its ETag against before it parses anything.
    messageGetSummary(messageId: string): EmailSummary | undefined {
        return this.store.getSummary(messageId);
    }

    async messageGetAttachment(messageId: string, index: number): Promise<Attachment> {
        const attachments = await this.store.getAttachments(messageId);
        if (index < 0 || index >= attachments.length) {
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

        // Raw bytes, not a `.text()` round-trip: decoding corrupts non-UTF-8 mail, and a copy is not mail arriving.
        const bytes = Buffer.from(await this.store.getRawMessage(messageId));
        await this.store.append(targetMailbox, bytes, { arrival: false });
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
        const existingId = draftIdOf(email);
        const hasNewTemps = !!options.tempAttachmentIds?.length;

        // A body-only save skips the EML re-compose, so an IMAP client reading Drafts sees stale content until a full save.
        if (existingId && !hasNewTemps && !options.forceFullSave) {
            const dbRecord = this.store.getSummary(existingId);
            if (dbRecord) {
                const meta = await this.store.readDraftMeta(existingId);
                if (meta && meta.attachments.length > 0) {
                    // The keep list names raw EML parts: anything but the sidecar's exact set, or an unvalidated index, needs a rebuild.
                    const parts = meta.attachments.flatMap((a) =>
                        typeof a.index !== 'number' ? [] : [{ ...a, index: a.index }],
                    );
                    const kept = options.keepAttachmentIndexes ? new Set(options.keepAttachmentIndexes) : null;
                    const keepAll =
                        parts.length === meta.attachments.length &&
                        (!kept || (kept.size === parts.length && parts.every((a) => kept.has(a.index))));

                    const stale = meta.lastFullSaveAt && Date.now() - meta.lastFullSaveAt > FULL_SAVE_INTERVAL_MS;
                    if (keepAll && !stale) {
                        return this.draftFastSave(email, existingId, meta, parts, dbRecord);
                    }
                }
            }
        }

        return this.draftFullSave(email, existingId, options);
    }

    private async draftFastSave(
        email: NewDraft | EmailDraft,
        existingId: string,
        prevMeta: DraftMeta,
        parts: Array<Required<DraftMetaAttachment>>,
        dbRecord: EmailSummary,
    ): Promise<EmailDraft> {
        const driveReferences = email.driveReferences ?? prevMeta.driveReferences;
        const meta: DraftMeta = {
            subject: email.subject || '',
            to: email.to,
            cc: email.cc,
            bcc: email.bcc,
            text: email.text || '',
            html: email.html || '',
            attachments: parts,
            driveReferences,
            inReplyTo: email.inReplyTo,
            references: email.references,
            lastFullSaveAt: prevMeta.lastFullSaveAt,
        };
        await this.store.writeDraftMeta(existingId, meta);

        const textShort = (email.text || '').slice(0, MAIL_PREVIEW_CHARS);
        this.store.applyDraftMeta(existingId, meta);

        this.emit(SSEventType.MAIL_DRAFT_UPDATED, { messageId: existingId, mailbox: MAILBOX_DRAFTS });

        const user = this.home.user;
        const attachments = parts.map((a) => ({
            contentType: a.contentType,
            filename: a.filename,
            content: Buffer.alloc(0),
            size: a.size,
            index: a.index,
        }));

        return {
            ...dbRecord,
            subject: meta.subject,
            textShort,
            hasAttachments: attachments.length > 0,
            attachments,
            html: meta.html,
            text: meta.text,
            to: email.to,
            cc: email.cc,
            bcc: email.bcc,
            from: {
                value: [{ address: user.email, name: user.name }],
                text: user.email,
            },
            messageId: email.messageId,
            inReplyTo: email.inReplyTo,
            references: email.references,
            driveReferences: driveReferences ?? [],
        };
    }

    private async draftFullSave(
        email: NewDraft | EmailDraft,
        existingId: string | undefined,
        options: Pick<DraftUpdateOptions, 'tempAttachmentIds' | 'keepAttachmentIndexes'>,
    ): Promise<EmailDraft> {
        const user = this.home.user;

        // Caller-supplied refs win; otherwise carry forward whatever was last persisted.
        let driveReferences = email.driveReferences;

        // to/cc/bcc stay request-verbatim: the FE sends `undefined` for "cleared", so a `?? meta.X` would resurrect a recipient.
        if (existingId) {
            const meta = await this.store.readDraftMeta(existingId);
            if (meta) {
                email = {
                    ...email,
                    subject: email.subject ?? meta.subject,
                    text: email.text ?? meta.text,
                    html: email.html || meta.html, // || not ?? — empty html also falls back to the sidecar
                    inReplyTo: email.inReplyTo ?? meta.inReplyTo,
                    references: email.references ?? meta.references,
                };
                driveReferences = driveReferences ?? meta.driveReferences;
            }
        }

        const existingAttachments: EmlAttachment[] = [];
        if (existingId && this.store.getSummary(existingId)) {
            const attachments = await this.store.getAttachments(existingId);
            const keepSet = options.keepAttachmentIndexes ? new Set(options.keepAttachmentIndexes) : null;
            for (const a of attachments) {
                if (keepSet && !keepSet.has(a.index)) continue;
                existingAttachments.push({
                    filename: mailAttachmentName(a, a.index),
                    content: Buffer.from(a.content),
                    contentType: a.contentType,
                });
            }
            await this.store.delete(existingId);
        }

        const newAttachments: EmlAttachment[] = [];
        for (const tempId of options.tempAttachmentIds ?? []) {
            const temp = await this.store.readDraftTempFile(tempId);
            if (!temp) throw new ApiError(404, `Temp attachment '${tempId}' not found`);
            newAttachments.push({ filename: temp.filename, content: temp.content, contentType: temp.contentType });
        }

        const allAttachments = [...existingAttachments, ...newAttachments];

        const from: AddressObject = {
            value: [{ address: user.email, name: user.name }],
            text: user.email,
        };

        const newId = existingId ?? createUniqueMessageId();
        const cleanHtml = email.html || '';
        // Baked into the EML so the Sent copy and the SMTP message carry the links; the sidecar keeps the clean html for compose.
        const bakedHtml = driveReferences?.length ? appendReferenceLinks(cleanHtml, driveReferences) : cleanHtml;
        const emlContent = await createEmlContent({
            id: newId,
            subject: email.subject || '',
            from,
            to: email.to,
            cc: email.cc,
            bcc: email.bcc,
            text: email.text || '',
            html: bakedHtml,
            date: new Date(),
            inReplyTo: email.inReplyTo,
            references: email.references,
            attachments: allAttachments.length ? allAttachments : undefined,
        });

        // Persist under the id baked into the EML header: a minted id leaves the wire Message-ID out of sync with the Sent EML.
        const saved = await this.store.saveDraft(emlContent, newId);
        // saveDraft always writes the D flag; the guard is what carries that invariant into the type.
        if (!isEmailDraft(saved)) throw new Error(`Draft '${saved.id}' was saved without the draft flag`);

        for (const tempId of options.tempAttachmentIds ?? []) {
            await this.store.cleanupDraftTemp(tempId);
        }

        // Write draft-meta so subsequent body-only saves can use the fast path.
        await this.store.writeDraftMeta(saved.id, {
            subject: email.subject || '',
            to: email.to,
            cc: email.cc,
            bcc: email.bcc,
            text: email.text || '',
            html: cleanHtml,
            attachments: saved.attachments.map((a) => ({
                filename: mailAttachmentName(a, a.index),
                contentType: a.contentType,
                size: a.size,
                index: a.index,
            })),
            driveReferences,
            inReplyTo: email.inReplyTo,
            references: email.references,
            lastFullSaveAt: Date.now(),
        });

        this.emit(SSEventType.MAIL_DRAFT_UPDATED, { messageId: saved.id, mailbox: MAILBOX_DRAFTS });

        // The clean html goes back so compose does not re-render the baked card block.
        saved.html = cleanHtml;
        // messageSend needs the threading headers, and the EML re-parse is not relied on to recover them.
        saved.inReplyTo = email.inReplyTo;
        saved.references = email.references;
        // MailComposer strips Bcc from the compiled EML, so the re-parse never recovers it and messageSend would lose those recipients.
        saved.bcc = email.bcc;
        saved.driveReferences = driveReferences ?? [];
        return saved;
    }

    async uploadDraftAttachment(request: Request, maxSize: number): Promise<DraftAttachmentUpload> {
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

    async stageDriveAttachment(
        source: StorageFile,
        filename: string,
        contentType: string,
        maxSize: number,
    ): Promise<DraftAttachmentUpload> {
        // The route already checked the drive size, so maxBytes is only for a source that grows mid-read.
        try {
            return await this.store.persistDraftTemp(
                (writer) =>
                    consumeStream(source.stream(), (chunk) => writer.write(chunk), {
                        idleMs: getStorageTimeoutMs(),
                        maxBytes: maxSize,
                    }),
                filename,
                contentType,
            );
        } catch (e) {
            if (e instanceof ApiError && e.status === 413) throw attachmentTooLarge(maxSize);
            throw e;
        }
    }

    async messageSend(
        mailToSend: NewDraft | EmailDraft,
        options?: { grantAccessRefIds?: string[] },
    ): Promise<SentMailResult> {
        // Full EML rebuild so attachment content is available for SMTP.
        const mail = await this.draftFullSave(mailToSend, draftIdOf(mailToSend), {});
        const message = draftToOutboundMail(mail, this.home.user.email);
        const allRecipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];

        // Pre-bake bodies: an external copy personalises its links off this base, the internal copy bakes bare ones.
        const refs = mail.driveReferences ?? [];
        const baseHtml = message.html || '';
        const baseText = message.text;

        // Also bounded at the route schema; re-checked because `refs` can come from the draft sidecar.
        if (refs.length > MAX_SEND_REFERENCES) {
            throw new ApiError(400, `A message can have at most ${MAX_SEND_REFERENCES} attachment links`);
        }
        // Links count as content, so a ref-only send is legitimate and only an empty subject, body and ref list is refused.
        if (!message.subject.trim() && !message.text.trim() && !message.html && !refs.length) {
            throw new ApiError(400, 'Cannot send email with empty subject and body');
        }

        // A demo box has no MTA: fail loudly rather than pretend to send, with the message kept in Drafts.
        if (isDemo()) {
            throw new ApiError(
                403,
                'This is a shared demo, so outgoing email is turned off. Your message is saved in Drafts.',
            );
        }

        // Between the demo guard and delivery, so a grant failure aborts the send; only To/Cc addresses are ever granted.
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

        await this.store.deleteDraftMeta(mail.id);
        await this.messageMove(mail.id, MAILBOX_SENT);
        await this.store.setFlags(mail.id, { draft: false });
        this.emit(SSEventType.MAIL_FLAGS_CHANGED, { messageId: mail.id, mailbox: MAILBOX_SENT });
        this.emit(SSEventType.MAIL_SENT, { messageId: mail.id, mailbox: MAILBOX_SENT });

        return failedRecipients.length ? { ...mail, failedRecipients } : mail;
    }

    async destruct(): Promise<void> {
        await this.store.unwatch();
        await this.flushDraftSidecars();
        return this.store.destruct();
    }

    private async flushDraftSidecars(): Promise<void> {
        const ids = await this.store.listDraftMetaIds();
        for (const id of ids) {
            try {
                const dbRecord = this.store.getSummary(id);
                if (!dbRecord?.isDraft) {
                    await this.store.deleteDraftMeta(id);
                    continue;
                }
                const meta = await this.store.readDraftMeta(id);
                if (!meta) continue;
                await this.draftFullSave(
                    {
                        id,
                        subject: meta.subject,
                        text: meta.text,
                        html: meta.html,
                        to: meta.to,
                        cc: meta.cc,
                        bcc: meta.bcc,
                        driveReferences: meta.driveReferences,
                        inReplyTo: meta.inReplyTo,
                        references: meta.references,
                    },
                    id,
                    {},
                );
            } catch (err) {
                console.error(`[mail] Failed to flush draft sidecar ${id}:`, err);
            }
        }
    }
}
