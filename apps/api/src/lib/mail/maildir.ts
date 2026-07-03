import { MaxFileSizeExceededError, parseMultipartRequest } from '@mjackson/multipart-parser';
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
import { renderAttachmentPills } from '../core/mail-template';
import { sendMail } from '../core/mailer';
import type { Home } from '../home';
import type { StorageFile } from '../storage';
import type { DraftMeta } from './mail-domain';
import { parseEml } from './mail-parse';
import type { DraftUpdateOptions, MailFlag, MailSearchOptions, MailStore, MailStoreEvents } from './mail-store';
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

const FULL_SAVE_INTERVAL_MS = 5 * 60 * 1000;

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

export default class Maildir implements MailStore {
    private store: MaildirStore;
    private db!: MailDB;
    private events!: MailStoreEvents;
    private syncingMailboxes = new Map<string, Promise<void>>();

    constructor(private home: Home) {
        this.store = new MaildirStore(home.homeDir);
    }

    private emit(type: Parameters<typeof buildMailEvent>[0], mail: Parameters<typeof buildMailEvent>[1]): void {
        this.home.broadcast(buildMailEvent(type, mail));
    }

    async init(events: MailStoreEvents): Promise<boolean> {
        this.events = events;
        const isNew = !(await this.store.exists());
        if (isNew) {
            await this.store.createStandardMailboxes();
        }
        this.db = new MailDB(this.home);
        await this.db.init();
        return isNew;
    }

    watch(): void {
        this.store.watchMailboxes((mailbox) =>
            this.syncMailbox(mailbox).catch((err) => console.error('maildir: mailbox sync failed', err)),
        );
    }

    async unwatch(): Promise<void> {
        this.store.unwatchMailboxes();
        // Let any in-flight mailbox sync (kicked fire-and-forget by the watcher) finish before
        // the domain flushes drafts and the db closes — later sync phases would hit a closed db.
        await Promise.allSettled([...this.syncingMailboxes.values()]);
    }

    async size(): Promise<number> {
        return (await this.store.dirSize()) || this.db.size();
    }

    search(opts: MailSearchOptions): EmailSummary[] {
        return this.db.searchMail(opts);
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

    async listMessages(mailbox: string): Promise<EmailSummary[]> {
        if (!(await this.store.mailboxDirExists(mailbox))) {
            throw new ApiError(404, `Mailbox '${mailbox}' not found`);
        }
        await this.syncMailbox(mailbox);
        return this.db.getAllEmails(mailbox);
    }

    // -- Message operations --

    getSummary(messageId: string): EmailSummary | undefined {
        return this.db.getEmail(messageId);
    }

    // null means "not found" ONLY: no summary row (real cache-miss) or the .eml isn't
    // locatable. A parse/read/DB fault propagates — never masked as a missing message.
    async getMessage(messageId: string): Promise<Email | null> {
        const cached = this.db.getEmail(messageId);
        if (!cached) return null;

        const parsed = await this.readAndParse(messageId, cached.mailbox, cached.filename);
        if (!parsed) return null;

        applyFlagsFromFilename(parsed, cached.filename);
        return { ...parsed, ...cached } as Email;
    }

    async getRawMessage(messageId: string): Promise<ArrayBuffer> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Email '${messageId}' not found`);
        return this.store.getMessageFile(email.mailbox, email.filename).arrayBuffer();
    }

    async getAttachments(messageId: string): Promise<Attachment[]> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);
        const parsed = await this.readAndParse(messageId, email.mailbox, email.filename);
        return parsed?.attachments ?? [];
    }

    async append(mailbox: string, message: Buffer, opts?: { skipSync?: boolean }): Promise<string> {
        const { uniqueId } = await this.store.deliverAtomic(message, mailbox);
        if (!opts?.skipSync) await this.syncMailbox(mailbox);
        return uniqueId;
    }

    async delete(messageId: string): Promise<void> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        await this.store.deleteMessage(email.mailbox, email.filename);
        this.db.deleteEmail(messageId);
    }

    async move(messageId: string, targetMailbox: string): Promise<void> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        if (!(await this.store.mailboxDirExists(targetMailbox))) {
            throw new ApiError(404, `Target mailbox '${targetMailbox}' not found`);
        }

        await this.store.moveMessage(email.mailbox, email.filename, targetMailbox);
        this.db.moveEmail(messageId, targetMailbox);
    }

    async setFlags(messageId: string, changes: Partial<Record<MailFlag, boolean>>): Promise<void> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

        const newFlagStr = rebuildFlagsSuffix(email.filename, changes);
        const uniqueWithSize = email.filename.split(':')[0];
        const newFilename = `${uniqueWithSize}:2,${newFlagStr}`;

        if (newFilename !== email.filename) {
            await this.store.renameInCur(email.mailbox, email.filename, newFilename);
            this.db.setFilename(messageId, newFilename);
        }

        if (changes.seen !== undefined) this.db.setRead(messageId, changes.seen);
        if (changes.flagged !== undefined) this.db.setFlagged(messageId, changes.flagged);
        if (changes.draft !== undefined) this.db.setDraft(messageId, changes.draft);
    }

    readDraftMeta<T = Record<string, unknown>>(draftId: string): Promise<T | null> {
        return this.store.readDraftMeta<T>(draftId);
    }

    deleteDraftMeta(draftId: string): Promise<void> {
        return this.store.deleteDraftMeta(draftId);
    }

    cleanupStaleDraftTemps(maxAgeMs?: number): Promise<void> {
        return this.store.cleanupStaleDraftTemps(maxAgeMs);
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
        const toAddrObjs = email.to ? (Array.isArray(email.to) ? email.to : [email.to]) : [];
        const ccAddrObjs = email.cc ? (Array.isArray(email.cc) ? email.cc : [email.cc]) : [];
        const firstTo = toAddrObjs[0]?.value[0];
        const allRecipients = [...toAddrObjs, ...ccAddrObjs].flatMap((o) => o.value);
        const recipients = {
            toShort: firstTo?.name || firstTo?.address || '',
            toAddress: firstTo?.address || '',
            recipientsAll: allRecipients
                .map((a) => `${a.name || ''} ${a.address || ''}`.trim())
                .filter((s) => s.length > 0)
                .join('\n'),
        };
        this.db.updateDraftContent(existingId, meta.subject, email.text || '', recipients);

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
        await this.move(mail.id, 'Sent');
        this.emit(SSEventType.MAIL_MOVED, { messageId: mail.id, mailbox: 'Drafts', toMailbox: 'Sent' });
        await this.setFlags(mail.id, { draft: false });
        this.emit(SSEventType.MAIL_FLAGS_CHANGED, { messageId: mail.id, mailbox: 'Sent' });
        this.emit(SSEventType.MAIL_SENT, { messageId: mail.id, mailbox: 'Sent' });

        return mail;
    }

    // -- Sync --

    async syncMailbox(mailbox: string): Promise<void> {
        // Don't start a sync once teardown has begun — the watcher can fire one fire-and-forget
        // (init :98) and doSyncMailbox's later phases would query a closed db (see destruct).
        if (this.home.destructing) return;
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
                // Bulk sweep: parseEml throws on a bad message; log + skip so one unreadable
                // .eml can't abort the whole mailbox sync. ENOENT is a benign mid-sync race.
                try {
                    const file = this.store.getMessageFile(mailbox, fileName);
                    const parsed = await parseEml(id, mailbox, file);
                    applyFlagsFromFilename(parsed, fileName);
                    parsed.filename = fileName;
                    const isNew = this.db.addEmail(parsed as EmailSummary);
                    this.events.received(parsed, isNew);
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
                this.events.flagsChanged(id, mailbox);
            }
        }

        // Deleted messages (in DB but not on disk)
        for (const [id] of dbById) {
            if (!diskFiles.has(id)) {
                this.db.deleteEmail(id);
                this.events.deleted(id, mailbox);
            }
        }
    }

    // -- Private helpers --

    // Returns null ONLY when the .eml is genuinely not locatable (no filename, not on disk).
    // A parse/read fault propagates from parseEml — callers must not treat it as "not found".
    private async readAndParse(messageId: string, mailbox: string, filename?: string): Promise<Email | null> {
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
