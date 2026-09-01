import { MAX_SEND_REFERENCES } from '@workspace/lib/constants/mail';
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
    SentMailResult,
} from '@workspace/lib/types/mail';
import { SSEventType } from '@workspace/lib/types/sse';
import { processInboundImip, summarizeCalendarInvite } from '../calendar/imip';
import { isDemo } from '../config/env';
import { isInternalAddress } from '../config/server-config';
import { ApiError, STANDARD_MAILBOXES } from '../core';
import { renderAttachmentLinksText, renderAttachmentPills } from '../core/mail-template';
import { type OutboundMail, sendMail } from '../core/mailer';
import type { Home } from '../home';
import { MaxFileSizeExceededError, parseMultipartRequest } from '../multipart';
import type { StorageFile } from '../storage';
import { grantAccessForReferences } from './access-grants';
import { parseMail } from './mail-parser';
import type { MailSearchOptions, MailStore } from './mail-store';
import { createEmlContent, type EmlAttachment } from './mailfile';
import { buildRecipientSummary, createUniqueMessageId } from './mailutils';
import { MAX_PERSONALISED_SEND_BYTES } from './recipients';
import { draftToOutboundMail } from './sender';
import { buildMailEvent } from './sse-events';
import { welcomeMail } from './welcome';

export type DraftUpdateOptions = {
    tempAttachmentIds?: string[];
    keepAttachmentIndexes?: number[];
    forceFullSave?: boolean;
};

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
    inReplyTo?: string;
    references?: string[] | string;
    lastFullSaveAt?: number;
};

const FULL_SAVE_INTERVAL_MS = 5 * 60 * 1000;

function canonicalMailbox(name: string): string {
    if (name === '' || name.toLowerCase() === 'inbox') return '';
    return STANDARD_MAILBOXES.find((m) => m.toLowerCase() === name.toLowerCase()) ?? name;
}

function appendReferenceLinks(html: string, refs: AttachmentReference[], recipientEmail?: string): string {
    const refHtml = renderAttachmentPills(refs, recipientEmail);
    if (!refHtml) return html;
    if (!html) return refHtml;
    const replaced = html.replace(/<\/body>/i, `${refHtml}</body>`);
    return replaced !== html ? replaced : html + refHtml;
}

function extractRefs(email: NewDraft | EmailDraft): AttachmentReference[] | undefined {
    return 'driveReferences' in email ? email.driveReferences : undefined;
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
        const uniqueId = await this.store.append('', message);

        // Process iMIP calendar attachments (blocking so event exists before client queries)
        try {
            const parsed = parseMail(message);
            const hasCalendar = parsed.attachments.some((a) => a.contentType.startsWith('text/calendar'));
            if (hasCalendar) {
                processInboundImip(this.home, parsed);
            }
        } catch (error) {
            console.error('iMIP processing failed:', error);
        }

        return uniqueId;
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
        // null means "not found" ONLY: no summary row (real cache-miss) or the .eml isn't
        // locatable. A parse/read/DB fault propagates → Elysia 500 + log, never a silent 404.
        const message = await this.store.getMessage(messageId);
        if (!message) return null;

        // Summarize invite parts while the parsed content is still in memory, then blank it.
        for (const a of message.attachments) {
            if (a.contentType.startsWith('text/calendar')) {
                a.calendarInvite = summarizeCalendarInvite(a);
            }
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
        const existingId = email.id?.trim() || undefined;
        const hasNewTemps = !!options.tempAttachmentIds?.length;

        // Fast path: when a draft with attachments already exists on disk and no attachment
        // changes are requested, skip the expensive EML re-compose. Only write a lightweight
        // JSON sidecar with the updated headers/body and update the DB list entry.
        // Note: fast-path saves leave the EML stale on disk; IMAP clients reading Drafts
        // will see old content until a full save occurs.
        if (existingId && !hasNewTemps && !options.forceFullSave) {
            const dbRecord = this.store.getSummary(existingId);
            if (dbRecord) {
                const meta = await this.store.readDraftMeta<DraftMeta>(existingId);
                if (meta && meta.attachments.length > 0) {
                    const keepAll =
                        !options.keepAttachmentIndexes ||
                        (options.keepAttachmentIndexes.length === meta.attachments.length &&
                            options.keepAttachmentIndexes.every((v, i) => v === i));

                    const stale = meta.lastFullSaveAt && Date.now() - meta.lastFullSaveAt > FULL_SAVE_INTERVAL_MS;
                    if (keepAll && !stale) {
                        return this.draftFastSave(email, existingId, meta, dbRecord);
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
        dbRecord: EmailSummary,
    ): Promise<EmailDraft> {
        const driveReferences = extractRefs(email) ?? prevMeta.driveReferences;
        const meta: DraftMeta = {
            subject: email.subject || '',
            to: email.to,
            cc: email.cc,
            bcc: email.bcc,
            text: email.text || '',
            html: email.html || '',
            attachments: prevMeta.attachments,
            driveReferences,
            inReplyTo: email.inReplyTo,
            references: email.references,
            lastFullSaveAt: prevMeta.lastFullSaveAt,
        };
        await this.store.writeDraftMeta(existingId, meta);

        const textShort = (email.text || '').slice(0, 200);
        const recipients = buildRecipientSummary(email.to, email.cc);
        this.store.updateDraftContent(existingId, meta.subject, email.text || '', recipients);

        this.emit(SSEventType.MAIL_DRAFT_UPDATED, { messageId: existingId, mailbox: 'Drafts' });

        const user = this.home.user;
        const attachments = meta.attachments.map((a) => ({
            contentType: a.contentType,
            filename: a.filename,
            content: Buffer.alloc(0),
            size: a.size,
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
            messageId: 'messageId' in email ? email.messageId : undefined,
            inReplyTo: 'inReplyTo' in email ? email.inReplyTo : undefined,
            references: 'references' in email ? email.references : undefined,
            driveReferences: driveReferences ?? [],
        };
    }

    private async draftFullSave(
        email: NewDraft | EmailDraft,
        existingId: string | undefined,
        options: { tempAttachmentIds?: string[]; keepAttachmentIndexes?: number[] },
    ): Promise<EmailDraft> {
        const user = this.home.user;

        // Caller-supplied refs win; otherwise carry forward whatever was last persisted.
        let driveReferences = extractRefs(email);

        // When a draft-meta sidecar exists, prefer its header/body values when the request omits
        // them (they may be newer than the stale EML from a previous fast-path save). But to/cc/bcc
        // are taken request-verbatim: the FE sends `undefined` to mean "user cleared this field", so
        // a `?? meta.X` fallback would resurrect a removed recipient (as draftFastSave already avoids).
        // The staleness-flush rebuild is unaffected — it constructs `email` from meta, so those
        // values are already present verbatim.
        if (existingId) {
            const meta = await this.store.readDraftMeta<DraftMeta>(existingId);
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
            for (let i = 0; i < attachments.length; i++) {
                const a = attachments[i];
                if (!a.filename || a.contentType.startsWith('text/calendar')) continue;
                if (keepSet && !keepSet.has(i)) continue;
                existingAttachments.push({
                    filename: a.filename,
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
        // Bake ref links into the EML body so both the Sent copy and the outbound SMTP
        // message carry them. DraftMeta stores the *clean* html so the compose view shows
        // what the user typed, not the rendered card block.
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

        // Persist under the id baked into the EML header (newId), not existingId: on an id-less
        // save saveDraft would otherwise mint its own id, leaving saved.id out of sync with the
        // header — so the wire Message-ID (buildMessageId(saved.id)) wouldn't match the Sent EML.
        const saved = await this.store.saveDraft(emlContent, newId);

        for (const tempId of options.tempAttachmentIds ?? []) {
            await this.store.cleanupDraftTemp(tempId);
        }

        // Write draft-meta so subsequent body-only saves can use the fast path.
        const visibleAttachments = (saved.attachments ?? []).filter(
            (a) => a.filename && !a.contentType.startsWith('text/calendar'),
        );
        await this.store.writeDraftMeta(saved.id, {
            subject: email.subject || '',
            to: email.to,
            cc: email.cc,
            bcc: email.bcc,
            text: email.text || '',
            html: cleanHtml,
            attachments: visibleAttachments.map((a) => ({
                filename: a.filename!,
                contentType: a.contentType,
                size: a.size,
            })),
            driveReferences,
            inReplyTo: email.inReplyTo,
            references: email.references,
            lastFullSaveAt: Date.now(),
        } satisfies DraftMeta);

        this.emit(SSEventType.MAIL_DRAFT_UPDATED, { messageId: saved.id, mailbox: 'Drafts' });

        // Overlay the clean html so the client's compose view doesn't re-render the
        // baked card block that's in the parsed EML.
        saved.html = cleanHtml;
        // Mirror the threading headers so messageSend keeps them: the EML re-parse recovers them,
        // but don't rely on it — the fast-save path sets them here too (draftFastSave).
        saved.inReplyTo = email.inReplyTo;
        saved.references = email.references;
        // MailComposer strips Bcc from the compiled EML (bcc is envelope-only), so the re-parse
        // never recovers it — mirror it too, or messageSend can't address the bcc recipients.
        saved.bcc = email.bcc;
        (saved as EmailDraft).driveReferences = driveReferences ?? [];
        return saved as EmailDraft;
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
            if (e instanceof MaxFileSizeExceededError) {
                const limitMB = Math.floor(maxSize / (1024 * 1024));
                throw new ApiError(413, `Attachment exceeds ${limitMB}MB limit`);
            }
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
        // Source size is known from the drive DB; the route validates it against maxSize before
        // calling us. We still guard during streaming in case the source grows mid-read.
        return this.store.persistDraftTemp(
            async (writer) => {
                let size = 0;
                const reader = source.stream().getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > maxSize) {
                        const limitMB = Math.floor(maxSize / (1024 * 1024));
                        throw new ApiError(413, `Attachment exceeds ${limitMB}MB limit`);
                    }
                    writer.write(value);
                }
                return size;
            },
            filename,
            contentType,
        );
    }

    async messageSend(
        mailToSend: NewDraft | EmailDraft,
        options?: { grantAccessRefIds?: string[] },
    ): Promise<SentMailResult> {
        // Full EML rebuild so attachment content is available for SMTP. draftFullSave bakes
        // ref cards into the Sent-folder EML and returns `mail` with the *clean* html
        // (for the frontend). Re-bake here so the outbound SMTP body matches the Sent copy.
        // Normalise a blank id to undefined (as messageHandleDraft does): an empty string would
        // survive `?? createUniqueMessageId()` and bake a `Message-ID: <@domain>` into the EML.
        const mail = await this.draftFullSave(mailToSend, (mailToSend as EmailDraft).id?.trim() || undefined, {});
        const message = draftToOutboundMail(mail, this.home.user.email);
        const allRecipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];

        // Capture the pre-bake bodies: external copies personalise these per-recipient, while the
        // internal copy and the single-send path bake bare links off the same base.
        const refs = mail.driveReferences ?? [];
        const baseHtml = message.html || '';
        const baseText = message.text;

        // Also bounded at the route schema; re-checked because `refs` can come from the draft sidecar.
        if (refs.length > MAX_SEND_REFERENCES) {
            throw new ApiError(400, `A message can have at most ${MAX_SEND_REFERENCES} attachment links`);
        }
        // driveReferences count as content: a ref-only send (empty subject/body but with attachment
        // links) is legitimate. Reject only when subject, body AND refs are all empty.
        if (!message.subject.trim() && !message.text.trim() && !message.html && !refs.length) {
            throw new ApiError(400, 'Cannot send email with empty subject and body');
        }

        // A demo box has no MTA, so this send can't leave the building. Surface that as a toast
        // instead of silently pretending to send — draftFullSave above kept the message in Drafts.
        // (sendMail itself still no-ops in demo, for the background share/invite/iMIP notifications.)
        if (isDemo()) {
            throw new ApiError(
                403,
                'This is a shared demo, so outgoing email is turned off. Your message is saved in Drafts.',
            );
        }

        // Grant read access to any referenced documents the sender opted to share. Runs after the
        // demo guard (so a demo send grants nothing) and before delivery (so a grant failure aborts
        // the send). Grantable emails are the To/Cc set — the canonicaliser already deduped with
        // to > cc > bcc precedence, so pure-Bcc addresses are excluded by construction.
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

        // Personalising re-sends every file attachment once per external recipient, so a big deck to a
        // big list would push hundreds of megabytes through the MTA while the browser waits on us.
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
            // Split into a bare internal copy plus one personalised copy per external recipient, each
            // with its own SMTP envelope so a leaked `?email=` link can never reach the wrong person.
            const envelopeFrom = message.from!.address;
            const { bcc: _bcc, ...base } = message;
            const buildCopy = (recipientEmail: string | undefined, envelopeTo: string[]): OutboundMail => ({
                ...base,
                html: appendReferenceLinks(baseHtml, refs, recipientEmail),
                text: baseText + renderAttachmentLinksText(refs, recipientEmail),
                envelope: { from: envelopeFrom, to: envelopeTo },
            });

            const copies: OutboundMail[] = [];
            const internal = allRecipients.filter((r) => isInternalAddress(r.address)).map((r) => r.address);
            if (internal.length) copies.push(buildCopy(undefined, internal));
            for (const ext of externals) {
                copies.push(buildCopy(ext.address, [ext.address]));
            }

            let anyAccepted = false;
            for (const copy of copies) {
                if (await sendMail(copy)) anyAccepted = true;
                else failedRecipients.push(...copy.envelope!.to);
            }
            if (!anyAccepted) {
                throw new ApiError(500, 'Failed to send email');
            }
        }

        await this.store.deleteDraftMeta(mail.id);
        await this.messageMove(mail.id, 'Sent');
        await this.store.setFlags(mail.id, { draft: false });
        this.emit(SSEventType.MAIL_FLAGS_CHANGED, { messageId: mail.id, mailbox: 'Sent' });
        this.emit(SSEventType.MAIL_SENT, { messageId: mail.id, mailbox: 'Sent' });

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
                const meta = await this.store.readDraftMeta<DraftMeta>(id);
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
