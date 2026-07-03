import type { Attachment, DraftAttachmentUpload, Email, EmailSummary, MaildirMailbox } from '@workspace/lib/types/mail';
import type { FileSink } from 'bun';
import { ApiError, STANDARD_MAILBOXES } from '../core';
import type { Home } from '../home';
import { parseEml } from './mail-parse';
import type { MailFlag, MailSearchOptions, MailStore, MailStoreEvents } from './mail-store';
import MailDB from './maildb';
import { MaildirStore } from './maildir-store';
import {
    applyFlagsFromFilename,
    getMailIDfromFileName,
    getStandardMailboxFlags,
    parseFlagsFromFilename,
    rebuildFlagsSuffix,
} from './mailutils';

export default class Maildir implements MailStore {
    private store: MaildirStore;
    private db!: MailDB;
    private events!: MailStoreEvents;
    private syncingMailboxes = new Map<string, Promise<void>>();

    constructor(private home: Home) {
        this.store = new MaildirStore(home.homeDir);
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

    async saveDraft(raw: string, existingId?: string): Promise<Email> {
        const { uniqueId, filename } = await this.store.deliverToCur(
            'Drafts',
            raw,
            { draft: true, seen: true },
            existingId,
        );

        const parsed = await this.readAndParse(uniqueId, 'Drafts', filename);
        if (!parsed) {
            await this.store.deleteMessage('Drafts', filename).catch(() => {});
            throw new ApiError(500, 'Failed to parse saved draft');
        }

        applyFlagsFromFilename(parsed, filename);
        parsed.filename = filename;
        parsed.mailbox = 'Drafts';
        this.db.addEmail(parsed as EmailSummary);
        return parsed;
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

    updateDraftContent(
        id: string,
        subject: string,
        text: string,
        recipients?: { toShort: string; toAddress: string; recipientsAll: string },
    ): void {
        this.db.updateDraftContent(id, subject, text, recipients);
    }

    // -- Draft sidecar + temp staging --

    writeDraftMeta(draftId: string, meta: Record<string, unknown>): Promise<void> {
        return this.store.writeDraftMeta(draftId, meta);
    }

    readDraftMeta<T = Record<string, unknown>>(draftId: string): Promise<T | null> {
        return this.store.readDraftMeta<T>(draftId);
    }

    deleteDraftMeta(draftId: string): Promise<void> {
        return this.store.deleteDraftMeta(draftId);
    }

    listDraftMetaIds(): Promise<string[]> {
        return this.store.listDraftMetaIds();
    }

    async persistDraftTemp(
        write: (writer: FileSink) => Promise<number>,
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

    readDraftTempFile(tempId: string): Promise<{ content: Buffer; filename: string; contentType: string } | null> {
        return this.store.readDraftTempFile(tempId);
    }

    cleanupDraftTemp(tempId: string): Promise<void> {
        return this.store.cleanupDraftTemp(tempId);
    }

    cleanupStaleDraftTemps(maxAgeMs?: number): Promise<void> {
        return this.store.cleanupStaleDraftTemps(maxAgeMs);
    }

    // -- Sync --

    async syncMailbox(mailbox: string): Promise<void> {
        // Don't start a sync once teardown has begun — the watcher can fire one fire-and-forget
        // (watch()) and doSyncMailbox's later phases would query a closed db (see destruct).
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
        if (this.db) {
            await this.db.destruct();
        }
    }
}
