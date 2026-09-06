import type { FSWatcher } from 'node:fs';
import type {
    Attachment,
    DraftAttachmentUpload,
    Email,
    EmailSummary,
    MaildirMailbox,
    RecipientSummary,
} from '@workspace/lib/types/mail';
import type { BunFile, FileSink } from 'bun';
import { Semaphore } from '../../utils/semaphore';
import { invalidateMailSize } from '../config/enforcement';
import { ApiError, LocalFilesystem, PATHS, STANDARD_MAILBOXES } from '../core';
import type { Home } from '../home';
import { parseEml, parseEmlBytes } from './mail-parse';
import type { DraftMeta, MailFlag, MailSearchOptions, MailStore, MailStoreEvents } from './mail-store';
import MailDB from './maildb';
import {
    applyFlagsFromFilename,
    buildMaildirFilename,
    createUniqueMessageId,
    getMailIDfromFileName,
    getStandardMailboxFlags,
    parseFlagsFromFilename,
    rebuildFlagsSuffix,
} from './mailutils';

const STALE_DRAFT_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class MaildirStore implements MailStore {
    readonly basePath: string;
    readonly storage: LocalFilesystem;
    private db!: MailDB;
    private events!: MailStoreEvents;
    private syncingMailboxes = new Map<string, Promise<void>>();
    // Reconciliation (doSyncMailbox) must not straddle a mutation's fs+db pair, or its delete phase drops just-moved rows.
    private storeLock = new Semaphore(1);
    private watchers: FSWatcher[] = [];

    constructor(private home: Home) {
        this.basePath = PATHS.MAIL.MAILDIR;
        this.storage = new LocalFilesystem(`${home.homeDir}/${PATHS.MAIL.ROOT}`);
    }

    // -- Lifecycle --

    async init(events: MailStoreEvents): Promise<boolean> {
        this.events = events;
        const isNew = !(await this.exists());
        if (isNew) {
            await this.createStandardMailboxes();
        }
        this.db = new MailDB(this.home);
        await this.db.init();
        return isNew;
    }

    watch(): void {
        for (const mailbox of STANDARD_MAILBOXES) {
            const mailboxPath = this.mailboxDir(mailbox);
            for (const subdir of [PATHS.MAIL.CUR, PATHS.MAIL.NEW]) {
                try {
                    const watcher = this.storage.watch(this.storage.pathJoin(mailboxPath, subdir), () =>
                        this.syncMailbox(mailbox).catch((err) => console.error('maildir: mailbox sync failed', err)),
                    );
                    this.watchers.push(watcher);
                } catch {
                    // Directory may not exist yet
                }
            }
        }
    }

    async unwatch(): Promise<void> {
        for (const watcher of this.watchers) watcher.close();
        this.watchers = [];
        // Let any in-flight mailbox sync (kicked fire-and-forget by the watcher) finish before
        // the domain flushes drafts and the db closes — later sync phases would hit a closed db.
        await Promise.allSettled([...this.syncingMailboxes.values()]);
    }

    async destruct(): Promise<void> {
        // init() can throw before the db opens, and the home destructs regardless.
        if (this.db) {
            await this.db.destruct();
        }
    }

    async size(): Promise<number> {
        return (await this.dirSize()) || this.db.size();
    }

    search(opts: MailSearchOptions): EmailSummary[] {
        return this.db.searchMail(opts);
    }

    // -- Mailbox operations --

    async mailboxesList(): Promise<MaildirMailbox[]> {
        const mailboxes: MaildirMailbox[] = [];
        for (const name of STANDARD_MAILBOXES) {
            if (await this.mailboxDirExists(name)) {
                mailboxes.push(this.getMailboxInfo(name));
            }
        }
        return mailboxes;
    }

    async mailboxCreate(mailbox: string): Promise<void> {
        if (await this.mailboxDirExists(mailbox)) {
            throw new ApiError(409, `Mailbox '${mailbox}' already exists`);
        }
        await this.createMailboxDir(mailbox);
    }

    async mailboxExists(mailbox: string): Promise<MaildirMailbox | false> {
        if (!(await this.mailboxDirExists(mailbox))) return false;
        return this.getMailboxInfo(mailbox);
    }

    async listMessages(
        mailbox: string,
        opts: { limit: number; before?: { date: Date; id: string } },
    ): Promise<EmailSummary[]> {
        if (!(await this.mailboxDirExists(mailbox))) {
            throw new ApiError(404, `Mailbox '${mailbox}' not found`);
        }
        // First open (empty DB) blocks so the user sees content immediately; otherwise serve the
        // DB now and reconcile in the background — new/changed rows arrive via the sync's SSE events.
        if (this.db.getEmailsCount(mailbox) === 0) {
            await this.syncMailbox(mailbox);
        } else {
            this.syncMailbox(mailbox).catch((err) => console.error('maildir: background mailbox sync failed', err));
        }
        return this.db.listMessages(mailbox, opts);
    }

    // -- Message operations --

    getSummary(messageId: string): EmailSummary | undefined {
        return this.db.getEmail(messageId);
    }

    // null means "not found" ONLY: no summary row (a real cache-miss). A parse/read/DB
    // fault propagates — never masked as a missing message.
    async getMessage(messageId: string): Promise<Email | null> {
        const cached = this.db.getEmail(messageId);
        if (!cached) return null;

        const parsed = await this.readAndParse(messageId, cached.mailbox, cached.filename);
        applyFlagsFromFilename(parsed, cached.filename);
        return { ...parsed, ...cached };
    }

    async getRawMessage(messageId: string): Promise<ArrayBuffer> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Email '${messageId}' not found`);
        return this.getMessageFile(email.mailbox, email.filename).arrayBuffer();
    }

    async getAttachments(messageId: string): Promise<Attachment[]> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);
        const parsed = await this.readAndParse(messageId, email.mailbox, email.filename);
        return parsed.attachments;
    }

    async append(mailbox: string, message: Buffer, opts?: { skipSync?: boolean }): Promise<string> {
        // Lock covers only the delivery — the follow-up sync takes the lock itself.
        const { uniqueId } = await this.storeLock.run(() => this.deliverAtomic(message, mailbox));
        if (!opts?.skipSync) await this.syncMailbox(mailbox);
        return uniqueId;
    }

    async saveDraft(raw: string, existingId?: string): Promise<Email> {
        // Parse the in-memory bytes up front so the heavyweight MIME parse stays off the lock —
        // the bytes we write are exactly what parseEml would read back from the delivered file.
        const messageId = existingId ?? createUniqueMessageId();
        const bytes = Buffer.from(raw, 'utf-8');
        const parsed = await parseEmlBytes(messageId, 'Drafts', bytes, bytes.length);

        // Hold the lock across the fs write + db.addEmail pair so a concurrent watcher sync can't
        // ingest the draft file first and fire a spurious received(isNew) event.
        return this.storeLock.run(async () => {
            const { filename } = await this.deliverToCur('Drafts', raw, { draft: true, seen: true }, messageId);

            applyFlagsFromFilename(parsed, filename);
            parsed.filename = filename;
            parsed.mailbox = 'Drafts';
            this.db.addEmail(parsed);
            return parsed;
        });
    }

    async delete(messageId: string): Promise<void> {
        return this.storeLock.run(async () => {
            const email = this.db.getEmail(messageId);
            if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

            await this.deleteMessage(email.mailbox, email.filename);
            this.db.deleteEmail(messageId);
            // Freed bytes must reach the next mail+contacts quota check, not a cached pre-delete figure.
            invalidateMailSize(this.home.user.id);
        });
    }

    async move(messageId: string, targetMailbox: string): Promise<void> {
        return this.storeLock.run(async () => {
            const email = this.db.getEmail(messageId);
            if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

            if (!(await this.mailboxDirExists(targetMailbox))) {
                throw new ApiError(404, `Target mailbox '${targetMailbox}' not found`);
            }

            await this.moveMessage(email.mailbox, email.filename, targetMailbox);
            this.db.moveEmail(messageId, targetMailbox);
        });
    }

    async setFlags(messageId: string, changes: Partial<Record<MailFlag, boolean>>): Promise<void> {
        return this.storeLock.run(async () => {
            const email = this.db.getEmail(messageId);
            if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

            const newFlagStr = rebuildFlagsSuffix(email.filename, changes);
            const uniqueWithSize = email.filename.split(':')[0];
            const newFilename = `${uniqueWithSize}:2,${newFlagStr}`;

            if (newFilename !== email.filename) {
                await this.renameInCur(email.mailbox, email.filename, newFilename);
                this.db.setFilename(messageId, newFilename);
            }

            if (changes.seen !== undefined) this.db.setRead(messageId, changes.seen);
            if (changes.flagged !== undefined) this.db.setFlagged(messageId, changes.flagged);
            if (changes.draft !== undefined) this.db.setDraft(messageId, changes.draft);
        });
    }

    updateDraftContent(id: string, subject: string, text: string, recipients?: RecipientSummary): void {
        this.db.updateDraftContent(id, subject, text, recipients);
    }

    // -- Sync --

    private async syncMailbox(mailbox: string): Promise<void> {
        // Don't start a sync once teardown has begun — the watcher can fire one fire-and-forget
        // (watch()) and doSyncMailbox's later phases would query a closed db (see destruct).
        if (this.home.destructing) return;
        const running = this.syncingMailboxes.get(mailbox);
        if (running) return running;

        const promise = this.storeLock.run(() => this.doSyncMailbox(mailbox));
        this.syncingMailboxes.set(mailbox, promise);
        try {
            await promise;
        } finally {
            this.syncingMailboxes.delete(mailbox);
        }
    }

    private async doSyncMailbox(mailbox: string): Promise<void> {
        await this.moveNewToCur(mailbox);

        const diskFiles = new Map<string, string>();
        for (const fileName of await this.listCurFiles(mailbox)) {
            if (!fileName.startsWith('.')) {
                diskFiles.set(getMailIDfromFileName(fileName), fileName);
            }
        }

        const dbRecords = this.db.getAllEmails(mailbox);
        const dbById = new Map(dbRecords.map((r) => [r.id, r]));

        // New messages (on disk but not in DB): parse in chunks, then bulk-insert each chunk in
        // one transaction — with `addEmail` at ~71% of a 92s cold sync of 100k messages, batching
        // the inserts (and skipping the per-row SELECT the diff map already made redundant) is the
        // single biggest cold-index win. `received` fires per message but after the chunk commits,
        // so a big sync is naturally throttled to one SSE burst per chunk instead of per message.
        const NEW_CHUNK = 250;
        const newEntries = [...diskFiles].filter(([id]) => !dbById.has(id));
        for (let i = 0; i < newEntries.length; i += NEW_CHUNK) {
            const chunk = newEntries.slice(i, i + NEW_CHUNK);
            // Keep the parsed Email (not EmailSummary) — events.received needs the full parse
            // (e.g. `from`) for the notification; insertEmails only reads the EmailSummary subset.
            const parsed: Email[] = [];
            for (const [id, fileName] of chunk) {
                // parseEml throws on a bad message; log + skip so one unreadable .eml can't drop
                // the rest of the chunk. ENOENT is a benign mid-sync race.
                try {
                    const file = this.getMessageFile(mailbox, fileName);
                    const p = await parseEml(id, mailbox, file);
                    applyFlagsFromFilename(p, fileName);
                    p.filename = fileName;
                    parsed.push(p);
                } catch (e: unknown) {
                    if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT'))
                        console.warn(`syncMailbox: failed to parse ${fileName}:`, e instanceof Error ? e.message : e);
                }
            }
            this.db.insertEmails(parsed);
            for (const p of parsed) this.events.received(p, true);
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

    // -- Draft meta sidecar (lightweight body-only saves) --

    private getDraftMetaDir(): string {
        return 'draft-meta';
    }

    private getDraftMetaPath(draftId: string): string {
        return this.storage.pathJoin(this.getDraftMetaDir(), `${this.sanitizeTempId(draftId)}.json`);
    }

    private async ensureDraftMetaDir(): Promise<void> {
        const dir = this.getDraftMetaDir();
        if (!(await this.storage.dirExists(dir))) {
            await this.storage.mkdir(dir);
        }
    }

    async writeDraftMeta(draftId: string, meta: DraftMeta): Promise<void> {
        await this.ensureDraftMetaDir();
        await this.storage.write(this.getDraftMetaPath(draftId), JSON.stringify(meta));
    }

    async readDraftMeta(draftId: string): Promise<DraftMeta | null> {
        const path = this.getDraftMetaPath(draftId);
        if (!(await this.storage.fileExists(path))) return null;
        return this.storage.file(path).json();
    }

    async deleteDraftMeta(draftId: string): Promise<void> {
        const path = this.getDraftMetaPath(draftId);
        try {
            if (await this.storage.fileExists(path)) {
                await this.storage.unlink(path);
            }
        } catch {}
    }

    async listDraftMetaIds(): Promise<string[]> {
        const dir = this.getDraftMetaDir();
        if (!(await this.storage.dirExists(dir))) return [];
        const files = await this.storage.readdir(dir);
        return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    }

    // -- Draft temp staging --

    async persistDraftTemp(
        write: (writer: FileSink) => Promise<number>,
        filename: string,
        contentType: string,
    ): Promise<DraftAttachmentUpload> {
        await this.ensureDraftTempDir();
        const tempId = crypto.randomUUID();
        const writer = this.openDraftTempWriter(tempId);
        let size: number;
        try {
            size = await write(writer);
            await writer.end();
        } catch (e) {
            await writer.end();
            await this.cleanupDraftTemp(tempId);
            throw e;
        }
        const meta = { filename, size, contentType };
        try {
            await this.writeDraftTempMeta(tempId, meta);
        } catch (e) {
            await this.cleanupDraftTemp(tempId);
            throw e;
        }
        return { tempId, ...meta };
    }

    private openDraftTempWriter(tempId: string) {
        return this.storage.file(this.getDraftTempPath(tempId)).writer({ highWaterMark: 256 * 1024 });
    }

    private async writeDraftTempMeta(
        tempId: string,
        meta: { filename: string; size: number; contentType: string },
    ): Promise<void> {
        await this.storage.write(this.getDraftTempMetaPath(tempId), JSON.stringify(meta));
    }

    async readDraftTempFile(
        tempId: string,
    ): Promise<{ content: Buffer; filename: string; contentType: string } | null> {
        const tempPath = this.getDraftTempPath(tempId);
        const metaPath = this.getDraftTempMetaPath(tempId);
        const file = this.storage.file(tempPath);
        if (!(await file.exists())) return null;
        const metaFile = this.storage.file(metaPath);
        const meta: { filename: string; contentType: string } = (await metaFile.exists())
            ? await metaFile.json()
            : { filename: tempId, contentType: 'application/octet-stream' };
        return {
            content: Buffer.from(await file.arrayBuffer()),
            filename: meta.filename,
            contentType: meta.contentType,
        };
    }

    private getDraftTempDir(): string {
        // Sibling of the Maildir tree (not inside it) so Dovecot IMAP doesn't see it as a folder.
        return 'draft-attachments';
    }

    private async ensureDraftTempDir(): Promise<void> {
        const dir = this.getDraftTempDir();
        if (!(await this.storage.dirExists(dir))) {
            await this.storage.mkdir(dir);
        }
    }

    private sanitizeTempId(tempId: string): string {
        return tempId.replace(/[^a-zA-Z0-9-_]/g, '_');
    }

    private getDraftTempPath(tempId: string): string {
        return this.storage.pathJoin(this.getDraftTempDir(), this.sanitizeTempId(tempId));
    }

    private getDraftTempMetaPath(tempId: string): string {
        return `${this.getDraftTempPath(tempId)}.json`;
    }

    async cleanupDraftTemp(tempId: string): Promise<void> {
        const tempPath = this.getDraftTempPath(tempId);
        const metaPath = this.getDraftTempMetaPath(tempId);
        try {
            if (await this.storage.fileExists(tempPath)) {
                await this.storage.unlink(tempPath);
            }
        } catch {}
        try {
            if (await this.storage.fileExists(metaPath)) {
                await this.storage.unlink(metaPath);
            }
        } catch {}
    }

    async cleanupStaleDraftTemps(): Promise<void> {
        const dir = this.getDraftTempDir();
        if (!(await this.storage.dirExists(dir))) return;
        const now = Date.now();
        for (const name of await this.storage.readdir(dir)) {
            const filePath = this.storage.pathJoin(dir, name);
            try {
                const stat = await this.storage.stat(filePath);
                if (now - stat.mtimeMs > STALE_DRAFT_TEMP_MAX_AGE_MS) {
                    await this.storage.unlink(filePath);
                }
            } catch {}
        }
    }

    // -- Maildir filesystem primitives --

    private async exists(): Promise<boolean> {
        return this.storage.dirExists(this.basePath);
    }

    private async createStandardMailboxes(): Promise<void> {
        for (const mailbox of STANDARD_MAILBOXES) {
            if (!(await this.storage.dirExists(this.mailboxDir(mailbox)))) {
                await this.createMailboxDir(mailbox);
            }
        }

        const subscriptions = `${STANDARD_MAILBOXES.filter((m) => m !== '').join('\n')}\n`;
        await this.storage.write(this.storage.pathJoin(this.basePath, 'subscriptions'), subscriptions);
    }

    private async mailboxDirExists(mailbox: string): Promise<boolean> {
        return this.storage.dirExists(this.mailboxDir(mailbox));
    }

    private async createMailboxDir(mailbox: string): Promise<void> {
        const mailboxPath = this.mailboxDir(mailbox);
        await this.storage.mkdir(mailboxPath);
        await this.storage.mkdir(this.storage.pathJoin(mailboxPath, PATHS.MAIL.CUR));
        await this.storage.mkdir(this.storage.pathJoin(mailboxPath, PATHS.MAIL.NEW));
        await this.storage.mkdir(this.storage.pathJoin(mailboxPath, PATHS.MAIL.TMP));
        if (mailbox !== '') {
            await this.storage.write(this.storage.pathJoin(mailboxPath, 'maildirfolder'), '');
        }
    }

    private async deliverAtomic(message: Buffer, mailbox: string): Promise<{ uniqueId: string; size: number }> {
        const uniqueId = createUniqueMessageId();
        const size = message.byteLength;
        const filename = `${uniqueId},S=${size}`;
        const mailboxPath = this.mailboxDir(mailbox);

        const tmpPath = this.storage.pathJoin(mailboxPath, PATHS.MAIL.TMP, filename);
        await this.storage.write(tmpPath, message);

        const newPath = this.storage.pathJoin(mailboxPath, PATHS.MAIL.NEW, filename);
        await this.storage.rename(tmpPath, newPath);

        return { uniqueId, size };
    }

    private async deliverToCur(
        mailbox: string,
        message: string,
        flags: Partial<Record<MailFlag, boolean>>,
        existingId: string,
    ): Promise<{
        uniqueId: string;
        size: number;
        filename: string;
    }> {
        const size = Buffer.byteLength(message, 'utf-8');
        const filename = buildMaildirFilename(existingId, flags, size);
        const mailboxPath = this.mailboxDir(mailbox);

        const tmpPath = this.storage.pathJoin(mailboxPath, PATHS.MAIL.TMP, filename);
        await this.storage.write(tmpPath, message);

        const curPath = this.storage.pathJoin(mailboxPath, PATHS.MAIL.CUR, filename);
        await this.storage.rename(tmpPath, curPath);

        return { uniqueId: existingId, size, filename };
    }

    private async moveNewToCur(mailbox: string): Promise<void> {
        const mailboxPath = this.mailboxDir(mailbox);
        const newPath = this.storage.pathJoin(mailboxPath, PATHS.MAIL.NEW);
        if (!(await this.storage.dirExists(newPath))) return;

        for (const fileName of await this.storage.readdir(newPath)) {
            if (fileName.startsWith('.')) continue;
            const src = this.storage.pathJoin(newPath, fileName);
            const curName = fileName.includes(':') ? fileName : `${fileName}:2,`;
            const dst = this.storage.pathJoin(mailboxPath, PATHS.MAIL.CUR, curName);
            try {
                await this.storage.rename(src, dst);
            } catch (e: unknown) {
                if (e instanceof Error && 'code' in e && e.code !== 'ENOENT') throw e;
            }
        }
    }

    private async listCurFiles(mailbox: string): Promise<string[]> {
        const curPath = this.storage.pathJoin(this.mailboxDir(mailbox), PATHS.MAIL.CUR);
        if (!(await this.storage.dirExists(curPath))) return [];
        return this.storage.readdir(curPath);
    }

    getMessageFile(mailbox: string, filename: string): BunFile {
        const filePath = this.storage.pathJoin(this.mailboxDir(mailbox), PATHS.MAIL.CUR, filename);
        return this.storage.file(filePath);
    }

    private async moveMessage(fromMailbox: string, fromFilename: string, toMailbox: string): Promise<void> {
        const srcPath = this.storage.pathJoin(this.mailboxDir(fromMailbox), PATHS.MAIL.CUR, fromFilename);
        const dstPath = this.storage.pathJoin(this.mailboxDir(toMailbox), PATHS.MAIL.CUR, fromFilename);
        await this.storage.rename(srcPath, dstPath);
    }

    private async renameInCur(mailbox: string, oldFilename: string, newFilename: string): Promise<void> {
        const curPath = this.storage.pathJoin(this.mailboxDir(mailbox), PATHS.MAIL.CUR);
        await this.storage.rename(
            this.storage.pathJoin(curPath, oldFilename),
            this.storage.pathJoin(curPath, newFilename),
        );
    }

    private async deleteMessage(mailbox: string, filename: string): Promise<void> {
        const filePath = this.storage.pathJoin(this.mailboxDir(mailbox), PATHS.MAIL.CUR, filename);
        if (await this.storage.fileExists(filePath)) {
            await this.storage.unlink(filePath);
        }
    }

    private async dirSize(): Promise<number> {
        return (await this.storage.dirSize(PATHS.MAIL.ROOT)) || 0;
    }

    private mailboxDir(mailbox: string): string {
        if (mailbox === '' || mailbox === 'INBOX') return this.basePath;
        if (/[^a-zA-Z0-9._\- /]/.test(mailbox) || mailbox.includes('..')) {
            throw new ApiError(400, `Invalid mailbox name: ${mailbox}`);
        }
        return `${this.basePath}/.${mailbox.replace('/', '.')}`;
    }

    // -- Private helpers --

    // A parse/read fault propagates from parseEml — callers must not treat it as "not found".
    private async readAndParse(messageId: string, mailbox: string, filename: string): Promise<Email> {
        return parseEml(messageId, mailbox, this.getMessageFile(mailbox, filename));
    }

    private getMailboxInfo(mailboxName: string): MaildirMailbox {
        return {
            path: mailboxName,
            name: mailboxName ? mailboxName.split('.').pop() || mailboxName : 'INBOX',
            delimiter: '.',
            flags: getStandardMailboxFlags(mailboxName),
            total: this.db.getEmailsCount(mailboxName),
            unread: this.db.getEmailsCountUnread(mailboxName),
        };
    }
}
