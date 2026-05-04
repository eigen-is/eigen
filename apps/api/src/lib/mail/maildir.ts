import { MaxFileSizeExceededError, parseMultipartRequest } from '@mjackson/multipart-parser';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type {
    AddressObject,
    DraftAttachmentUpload,
    Email,
    EmailDraft,
    EmailSummary,
    MaildirMailbox,
    NewDraft,
} from '@workspace/lib/types/mail';
import { SSEventType } from '@workspace/lib/types/sse';
import { ApiError, STANDARD_MAILBOXES } from '../core';
import { renderAttachmentPills } from '../core/mail-template';
import { sendMail } from '../core/mailer';
import type { Home } from '../home';
import type { StorageFile } from '../storage';
import { parseEml } from './mail-parse';
import MailDB from './maildb';
import { MaildirStore } from './maildir-store';
import { createEmlContent, type EmlAttachment } from './mailfile';
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

type DraftMeta = {
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

const FULL_SAVE_INTERVAL_MS = 5 * 60 * 1000;

function canonicalMailbox(name: string): string {
    if (name === '' || name.toLowerCase() === 'inbox') return '';
    return STANDARD_MAILBOXES.find((m) => m.toLowerCase() === name.toLowerCase()) ?? name;
}

function appendReferenceLinks(html: string, refs: AttachmentReference[]): string {
    const refHtml = renderAttachmentPills(refs);
    if (!refHtml) return html;
    if (!html) return refHtml;
    const replaced = html.replace(/<\/body>/i, `${refHtml}</body>`);
    return replaced !== html ? replaced : html + refHtml;
}

function extractRefs(email: NewDraft | EmailDraft): AttachmentReference[] | undefined {
    return 'driveReferences' in email ? email.driveReferences : undefined;
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
            const welcome = await welcomeMail(this.home.user.name, this.home.user.email);
            if (welcome) await this.store.deliverAtomic(welcome, '');
        }
        this.store.watchMailboxes((mailbox) =>
            this.syncMailbox(mailbox).catch((err) => console.error('maildir: mailbox sync failed', err)),
        );
        this.store
            .cleanupStaleDraftTemps()
            .catch((err) => console.error('maildir: stale draft temp cleanup failed', err));
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

            const result = { ...parsed, ...cached } as Email;

            // Overlay latest values from draft-meta sidecar (written by fast-path saves).
            // Applied after the spread so sidecar values win over both the stale EML
            // (parsed) and the DB summary row (cached).
            if (cached.isDraft) {
                const meta = await this.store.readDraftMeta<DraftMeta>(messageId);
                if (meta) {
                    result.subject = meta.subject;
                    result.html = meta.html;
                    result.text = meta.text;
                    if (meta.to) result.to = meta.to;
                    if (meta.cc) result.cc = meta.cc;
                    if (meta.bcc) result.bcc = meta.bcc;
                    result.driveReferences = meta.driveReferences ?? [];
                }
            }

            return result;
        } catch {
            return null;
        }
    }

    async messageGetFile(messageId: string): Promise<ArrayBuffer> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Email '${messageId}' not found`);
        return this.store.getMessageFile(email.mailbox, email.filename).arrayBuffer();
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

    async messageGetAttachments(messageId: string) {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);
        const parsed = await this.readAndParse(messageId, email.mailbox, email.filename);
        return parsed?.attachments ?? [];
    }

    async messageDelete(messageId: string): Promise<void> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        await this.store.deleteMessage(email.mailbox, email.filename);
        await this.store.deleteDraftMeta(messageId);
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

        const text = await this.store.getMessageFile(email.mailbox, email.filename).text();
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

    async messageHandleDraft(
        email: NewDraft | EmailDraft,
        options: { tempAttachmentIds?: string[]; keepAttachmentIndexes?: number[]; forceFullSave?: boolean } = {},
    ): Promise<EmailDraft> {
        const existingId = email.id?.trim() || undefined;
        const hasNewTemps = !!options.tempAttachmentIds?.length;

        // Fast path: when a draft with attachments already exists on disk and no attachment
        // changes are requested, skip the expensive EML re-compose. Only write a lightweight
        // JSON sidecar with the updated headers/body and update the DB list entry.
        // Note: fast-path saves leave the EML stale on disk; IMAP clients reading Drafts
        // will see old content until a full save occurs.
        if (existingId && !hasNewTemps && !options.forceFullSave) {
            const dbRecord = this.db.getEmail(existingId);
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
            lastFullSaveAt: prevMeta.lastFullSaveAt,
        };
        await this.store.writeDraftMeta(existingId, meta);

        const textShort = (email.text || '').slice(0, 200);
        this.db.updateDraftContent(existingId, meta.subject, textShort);

        this.emit(SSEventType.MAIL_DRAFT_UPDATED, { messageId: existingId, mailbox: 'Drafts' });

        const user = this.home.user;
        const attachments = meta.attachments.map((a) => ({
            type: 'attachment' as const,
            content: Buffer.alloc(0),
            contentType: a.contentType,
            contentDisposition: 'attachment',
            filename: a.filename,
            headers: new Map() as Email['headers'],
            headerLines: [] as unknown as Email['headerLines'],
            checksum: '',
            size: a.size,
            related: false,
        }));

        return {
            ...dbRecord,
            subject: meta.subject,
            textShort,
            hasAttachments: attachments.length > 0,
            attachments,
            headers: new Map() as Email['headers'],
            headerLines: [] as unknown as Email['headerLines'],
            html: meta.html,
            text: meta.text,
            to: email.to,
            cc: email.cc,
            bcc: email.bcc,
            from: {
                value: [{ address: user.email, name: user.name }],
                html: user.email,
                text: user.email,
            },
            messageId: 'messageId' in email ? email.messageId : undefined,
            inReplyTo: 'inReplyTo' in email ? email.inReplyTo : undefined,
            references: 'references' in email ? email.references : undefined,
            driveReferences: driveReferences ?? [],
        } as EmailDraft;
    }

    private async draftFullSave(
        email: NewDraft | EmailDraft,
        existingId: string | undefined,
        options: { tempAttachmentIds?: string[]; keepAttachmentIndexes?: number[] },
    ): Promise<EmailDraft> {
        const user = this.home.user;

        // Caller-supplied refs win; otherwise carry forward whatever was last persisted.
        let driveReferences = extractRefs(email);

        // When a draft-meta sidecar exists, prefer its header/body values (they may be newer
        // than the stale EML on disk from a previous fast-path save).
        if (existingId) {
            const meta = await this.store.readDraftMeta<DraftMeta>(existingId);
            if (meta) {
                email = {
                    ...email,
                    subject: email.subject ?? meta.subject,
                    text: email.text ?? meta.text,
                    html: email.html || meta.html, // || not ?? — mailparser uses `false` for "no HTML"
                    to: email.to ?? meta.to,
                    cc: email.cc ?? meta.cc,
                    bcc: email.bcc ?? meta.bcc,
                };
                driveReferences = driveReferences ?? meta.driveReferences;
            }
        }

        const existingAttachments: EmlAttachment[] = [];
        if (existingId) {
            const old = this.db.getEmail(existingId);
            if (old) {
                const parsed = await this.readAndParse(existingId, old.mailbox, old.filename);
                const keepSet = options.keepAttachmentIndexes ? new Set(options.keepAttachmentIndexes) : null;
                const attachments = parsed?.attachments ?? [];
                for (let i = 0; i < attachments.length; i++) {
                    const a = attachments[i];
                    if (!a.filename || a.contentType.startsWith('text/calendar')) continue;
                    if (keepSet && !keepSet.has(i)) continue;
                    if (!(a.content instanceof Uint8Array)) {
                        console.warn(
                            `draft ${existingId}: skipping attachment ${a.filename} (unexpected content type ${typeof a.content})`,
                        );
                        continue;
                    }
                    existingAttachments.push({
                        filename: a.filename,
                        content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content),
                        contentType: a.contentType,
                    });
                }
                await this.store.deleteMessage(old.mailbox, old.filename);
                this.db.deleteEmail(existingId);
            }
        }

        const newAttachments: EmlAttachment[] = [];
        for (const tempId of options.tempAttachmentIds ?? []) {
            const { content, filename, contentType } = await this.getDraftTempFile(tempId);
            newAttachments.push({ filename, content, contentType });
        }

        const allAttachments = [...existingAttachments, ...newAttachments];

        const from: AddressObject = {
            value: [{ address: user.email, name: user.name }],
            html: user.email,
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
            attachments: allAttachments.length ? allAttachments : undefined,
        });

        const { uniqueId, filename } = await this.store.deliverToCur(
            'Drafts',
            emlContent,
            { draft: true, seen: true },
            existingId,
        );

        for (const tempId of options.tempAttachmentIds ?? []) {
            await this.cleanupDraftTempFile(tempId);
        }

        const parsed = await this.readAndParse(uniqueId, 'Drafts', filename);
        if (!parsed) {
            await this.store.deleteMessage('Drafts', filename).catch(() => {});
            throw new ApiError(500, 'Failed to parse saved draft');
        }

        applyFlagsFromFilename(parsed, filename);
        parsed.filename = filename;
        parsed.mailbox = 'Drafts';
        this.db.addEmail(parsed as EmailSummary);

        // Write draft-meta so subsequent body-only saves can use the fast path.
        const visibleAttachments = (parsed.attachments ?? []).filter(
            (a) => a.filename && !a.contentType.startsWith('text/calendar'),
        );
        await this.store.writeDraftMeta(uniqueId, {
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
            lastFullSaveAt: Date.now(),
        } satisfies DraftMeta);

        this.emit(SSEventType.MAIL_DRAFT_UPDATED, { messageId: uniqueId, mailbox: 'Drafts' });

        // Overlay the clean html so the client's compose view doesn't re-render the
        // baked card block that's in the parsed EML.
        parsed.html = cleanHtml;
        (parsed as EmailDraft).driveReferences = driveReferences ?? [];
        return parsed as EmailDraft;
    }

    private async persistDraftTemp(
        write: (writer: ReturnType<MaildirStore['openDraftTempWriter']>) => Promise<number>,
        filename: string,
        contentType: string,
    ): Promise<DraftAttachmentUpload> {
        await this.store.ensureDraftTempDir();
        const tempId = crypto.randomUUID();
        const writer = this.store.openDraftTempWriter(tempId);
        let size: number;
        try {
            size = await write(writer);
            await writer.end();
        } catch (e) {
            await writer.end();
            await this.store.cleanupDraftTemp(tempId);
            throw e;
        }
        const meta = { filename, size, contentType };
        try {
            await this.store.writeDraftTempMeta(tempId, meta);
        } catch (e) {
            await this.store.cleanupDraftTemp(tempId);
            throw e;
        }
        return { tempId, ...meta };
    }

    async uploadDraftAttachment(request: Request, maxSize: number): Promise<DraftAttachmentUpload> {
        try {
            for await (const part of parseMultipartRequest(request, { maxFileSize: maxSize })) {
                if (!part.isFile || !part.filename) continue;
                return await this.persistDraftTemp(
                    async (writer) => {
                        let size = 0;
                        for (const chunk of part.content) {
                            writer.write(chunk);
                            size += chunk.length;
                        }
                        return size;
                    },
                    part.filename,
                    part.mediaType || 'application/octet-stream',
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
        return this.persistDraftTemp(
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

    async getDraftTempFile(tempId: string): Promise<{
        content: Buffer;
        filename: string;
        contentType: string;
    }> {
        const result = await this.store.readDraftTempFile(tempId);
        if (!result) throw new ApiError(404, `Temp attachment '${tempId}' not found`);
        return result;
    }

    async cleanupDraftTempFile(tempId: string): Promise<void> {
        await this.store.cleanupDraftTemp(tempId);
    }

    async messageSend(mailToSend: NewDraft | EmailDraft): Promise<EmailDraft> {
        // Full EML rebuild so attachment content is available for SMTP. draftFullSave bakes
        // ref cards into the Sent-folder EML and returns `mail` with the *clean* html
        // (for the frontend). Re-bake here so the outbound SMTP body matches the Sent copy.
        const mail = await this.draftFullSave(mailToSend, (mailToSend as EmailDraft).id?.trim(), {});
        const message = draftToOutboundMail(mail, this.home.user.email);
        if (mail.driveReferences?.length) {
            message.html = appendReferenceLinks(message.html || '', mail.driveReferences);
        }

        if (!message.subject.trim() && !message.text.trim() && !message.html) {
            throw new ApiError(400, 'Cannot send email with empty subject and body');
        }

        const sent = await sendMail(message);

        if (!sent) {
            throw new ApiError(500, 'Failed to send email');
        }

        await this.store.deleteDraftMeta(mail.id);
        await this.messageMove(mail.id, 'Sent');
        await this.renameFlag(mail.id, { draft: false }, SSEventType.MAIL_FLAGS_CHANGED);
        this.db.setDraft(mail.id, false);
        this.emit(SSEventType.MAIL_SENT, { messageId: mail.id, mailbox: 'Sent' });

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
                    const file = this.store.getMessageFile(mailbox, fileName);
                    const parsed = await parseEml(id, mailbox, file);
                    if (parsed) {
                        applyFlagsFromFilename(parsed, fileName);
                        parsed.filename = fileName;
                        const isNew = this.db.addEmail(parsed as EmailSummary);
                        this.emit(SSEventType.MAIL_RECEIVED, { messageId: id, mailbox });
                        if (isNew && parsed.fromShort) {
                            const fromEmail = parsed.from?.value?.[0]?.address ?? null;
                            this.home.notifications?.persist({
                                type: 'mail',
                                actorEmail: fromEmail,
                                title: 'New email',
                                body: parsed.subject
                                    ? `From ${parsed.fromShort}: ${parsed.subject}`
                                    : `New email from ${parsed.fromShort}`,
                                tag: 'mail:new',
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

            return parseEml(messageId, mailbox, this.store.getMessageFile(mailbox, filename));
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
        await this.flushDraftSidecars();
        if (this.db) {
            await this.db.destruct();
        }
    }

    private async flushDraftSidecars(): Promise<void> {
        const ids = await this.store.listDraftMetaIds();
        for (const id of ids) {
            try {
                const dbRecord = this.db.getEmail(id);
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
