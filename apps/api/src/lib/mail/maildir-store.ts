import type { FSWatcher } from 'node:fs';
import * as path from 'node:path';
import {
    isStandardMailbox,
    MAILBOX_DRAFTS,
    MAILBOX_INBOX,
    MAILBOX_INBOX_IMAP,
    mailboxListFlags,
    STANDARD_MAILBOXES,
} from '@workspace/lib/constants/mailboxes';
import type { Attachment, DraftAttachmentUpload, Email, EmailSummary, MaildirMailbox } from '@workspace/lib/types/mail';
import type { BunFile, FileSink } from 'bun';
import { Semaphore } from '../../utils/semaphore';
import { ApiError, isSafePathSegment, LocalFilesystem, PATHS } from '../core';
import type { Home } from '../home';
import { parseEml, parseEmlBytes } from './mail-parse';
import type { DraftMeta, MailFlag, MailSearchOptions, MailStore, MailStoreEvents } from './mail-store';
import MailDB from './maildb';
import {
    applyFlagsFromFilename,
    buildMaildirFilename,
    buildRecipientSummary,
    createUniqueMessageId,
    getMailIDfromFileName,
    parseFlagsFromFilename,
    rebuildFlagsSuffix,
} from './mailutils';

const STALE_DRAFT_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The Maildir spec's own age: a `tmp/` file older than this is a crash leftover, never an in-flight write.
const STALE_MAILDIR_TEMP_MAX_AGE_MS = 36 * 60 * 60 * 1000;
// Every mail SSE event re-lists the mailboxes, so the reconcile a listing kicks for a folder outside
// the standard six is due at most this often — a rescan of every folder per event is the whole cost.
const BACKGROUND_RECONCILE_INTERVAL_MS = 60 * 1000;
// Sibling of the Maildir tree (not inside it) so Dovecot IMAP doesn't see it as a folder.
const DRAFT_ATTACHMENTS_DIR = 'draft-attachments';

// Staged attachments are charged to the mail quota, and both surfaces that report it walk them here.
export function readDraftStagingSize(homeFs: LocalFilesystem): Promise<number> {
    return homeFs.dirSize(path.join(PATHS.MAIL.ROOT, DRAFT_ATTACHMENTS_DIR));
}

// A mailbox name is user-visible, so a segment may hold interior spaces — but never the `.` Maildir++
// delimiter, and never nothing at all.
const MAILBOX_SEGMENT = /^[A-Za-z0-9_\- ]+$/;

function isValidMailboxPath(mailbox: string): boolean {
    return mailbox.split(/[./]/).every((segment) => MAILBOX_SEGMENT.test(segment) && segment.trim() === segment);
}

// Refused, never mapped onto a safe name: two mapped ids would collide on one file.
function safeFileId(id: string): string {
    if (!isSafePathSegment(id)) throw new ApiError(400, `Invalid mail id: ${id}`);
    return id;
}

export class MaildirStore implements MailStore {
    readonly basePath: string;
    readonly storage: LocalFilesystem;
    private db!: MailDB;
    private events!: MailStoreEvents;
    private syncingMailboxes = new Map<string, Promise<void>>();
    private lastSyncStartedAt = new Map<string, number>();
    // Each id this store delivered, and whether it was an arrival — read by whichever sync reaches the
    // file first, this append's own or a watcher's.
    private deliveries = new Map<string, boolean>();
    // Reconciliation (doSyncMailbox) must not straddle a mutation's fs+db pair, or its delete phase drops just-moved rows.
    private storeLock = new Semaphore(1);
    private watchers: FSWatcher[] = [];
    // Running byte totals so size() answers from memory — the mail+contacts quota gate calls it on every
    // metered write, and an index sum plus a staging walk per call would make an N-card device sync O(N²).
    private indexBytes = 0;
    private stagedBytes = 0;

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
        // Seeded once from the index and the staging dir; every row and staged file adjusts it thereafter.
        this.indexBytes = this.db.size();
        await this.recountStaged();
        return isNew;
    }

    // The standard six only: a watcher per folder would cost a home with hundreds of IMAP folders
    // hundreds of handles against a per-user inotify limit every home shares.
    watch(): void {
        for (const mailbox of STANDARD_MAILBOXES) {
            const mailboxPath = this.mailboxDir(mailbox);
            for (const subdir of [PATHS.MAIL.CUR, PATHS.MAIL.NEW]) {
                try {
                    const watcher = this.storage.watch(path.join(mailboxPath, subdir), () =>
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
        // Let any in-flight mailbox sync (kicked fire-and-forget by a watcher or a listing) finish before
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
        return this.indexBytes + this.stagedBytes;
    }

    // The staging dir holds one compose session's attachments at most, so a re-walk per change costs
    // nothing next to writing the attachment and — unlike a delta per partial write — cannot drift.
    private async recountStaged(): Promise<void> {
        this.stagedBytes = await readDraftStagingSize(this.home.fs);
    }

    search(opts: MailSearchOptions): EmailSummary[] {
        return this.db.searchMail(opts);
    }

    // -- Mailbox operations --

    async mailboxesList(): Promise<MaildirMailbox[]> {
        const mailboxes: MaildirMailbox[] = [];
        for (const name of await this.listMailboxPaths()) {
            // Counts come from the index, never from a sync this waits on: messageMoveToTrash lists on each
            // trash action. A folder outside the standard six has no watcher, so this is where it reconciles
            // — in the background and at most once a minute, with a later listing and the sync's own SSE
            // events landing the counts.
            if (!isStandardMailbox(name) && this.reconcileDue(name)) {
                this.syncMailbox(name).catch((err) => console.error('maildir: background mailbox sync failed', err));
            }
            mailboxes.push(this.getMailboxInfo(name));
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

    async append(mailbox: string, message: Buffer, opts?: { skipSync?: boolean; arrival?: boolean }): Promise<string> {
        const uniqueId = createUniqueMessageId();
        // Recorded before the file lands: arriving is a property of the message, not of the sync that finds it.
        this.deliveries.set(uniqueId, opts?.arrival ?? true);
        // Lock covers only the delivery — the follow-up sync takes the lock itself.
        await this.storeLock.run(() => this.deliverAtomic(message, mailbox, uniqueId));
        if (!opts?.skipSync) await this.syncMailbox(mailbox);
        return uniqueId;
    }

    async saveDraft(raw: string, existingId?: string): Promise<Email> {
        // Parse the in-memory bytes up front so the heavyweight MIME parse stays off the lock —
        // the bytes we write are exactly what parseEml would read back from the delivered file.
        const messageId = existingId ?? createUniqueMessageId();
        const bytes = Buffer.from(raw, 'utf-8');
        const parsed = await parseEmlBytes(messageId, MAILBOX_DRAFTS, bytes, bytes.length);

        // Hold the lock across the fs write + db.addEmail pair so a concurrent watcher sync can't
        // ingest the draft file first and fire a spurious received(isNew) event.
        return this.storeLock.run(async () => {
            const { filename } = await this.deliverToCur(MAILBOX_DRAFTS, raw, { draft: true, seen: true }, messageId);

            applyFlagsFromFilename(parsed, filename);
            parsed.filename = filename;
            parsed.mailbox = MAILBOX_DRAFTS;
            // A full save rewrites the draft under its own id, so the row it replaces is credited back.
            const replaced = this.db.getEmail(messageId)?.size ?? 0;
            this.db.addEmail(parsed);
            this.indexBytes += parsed.size - replaced;
            return parsed;
        });
    }

    async delete(messageId: string): Promise<void> {
        return this.storeLock.run(async () => {
            const email = this.db.getEmail(messageId);
            if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

            await this.deleteMessage(email.mailbox, email.filename);
            this.db.deleteEmail(messageId);
            this.indexBytes -= email.size;
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

    applyDraftMeta(draftId: string, meta: DraftMeta): void {
        this.db.updateDraftContent(draftId, meta.subject, meta.text, buildRecipientSummary(meta.to, meta.cc));
    }

    // -- Sync --

    private reconcileDue(mailbox: string): boolean {
        const last = this.lastSyncStartedAt.get(mailbox);
        return last === undefined || Date.now() - last >= BACKGROUND_RECONCILE_INTERVAL_MS;
    }

    private async syncMailbox(mailbox: string): Promise<void> {
        // Don't start a sync once teardown has begun — the watcher can fire one fire-and-forget
        // (watch()) and doSyncMailbox's later phases would query a closed db (see destruct).
        if (this.home.destructing) return;
        this.lastSyncStartedAt.set(mailbox, Date.now());
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
        // A mailbox with no rows yet is being indexed for the first time — an old IMAP folder, or a home
        // whose mail.db was lost — so a file this store did not just deliver was discovered, not delivered,
        // and must not raise a new-mail notification.
        const indexed = dbRecords.length > 0;

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
            // Upsert, so a chunk can re-home a row that already exists: credit what it replaces.
            const replaced = this.db.sumSizes(parsed.map((p) => p.id));
            this.db.insertEmails(parsed);
            this.indexBytes += parsed.reduce((sum, p) => sum + p.size, 0) - replaced;
            // A fast save leaves the .eml stale, so a row rebuilt from it carries the last full save.
            if (mailbox === MAILBOX_DRAFTS) {
                for (const p of parsed) {
                    const meta = await this.readDraftMeta(p.id);
                    if (meta) this.applyDraftMeta(p.id, meta);
                }
            }
            for (const p of parsed) {
                const delivered = this.deliveries.get(p.id);
                this.deliveries.delete(p.id);
                this.events.received(p, delivered ?? indexed);
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
        for (const [id, record] of dbById) {
            if (!diskFiles.has(id)) {
                this.db.deleteEmail(id);
                this.indexBytes -= record.size;
                this.events.deleted(id, mailbox);
            }
        }
    }

    // -- Draft meta sidecar (lightweight body-only saves) --

    private getDraftMetaDir(): string {
        return 'draft-meta';
    }

    private getDraftMetaPath(draftId: string): string {
        return path.join(this.getDraftMetaDir(), `${safeFileId(draftId)}.json`);
    }

    async writeDraftMeta(draftId: string, meta: DraftMeta): Promise<void> {
        await this.storage.writeAtomic(this.getDraftMetaPath(draftId), JSON.stringify(meta));
    }

    async readDraftMeta(draftId: string): Promise<DraftMeta | null> {
        // The Drafts sync reads ids off disk, where another MDA's filename can hold characters no id Eigen
        // writes a sidecar under ever has: no sidecar can exist for one, and one file must not fail the sync.
        if (!isSafePathSegment(draftId)) return null;
        const metaPath = this.getDraftMetaPath(draftId);
        if (!(await this.storage.exists(metaPath))) return null;
        try {
            return await this.storage.file(metaPath).json();
        } catch {
            // Torn bytes from a crash read as absent, so the caller falls back to the .eml.
            return null;
        }
    }

    async deleteDraftMeta(draftId: string): Promise<void> {
        const metaPath = this.getDraftMetaPath(draftId);
        try {
            if (await this.storage.exists(metaPath)) {
                await this.storage.unlink(metaPath);
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
        await this.recountStaged();
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

    private async ensureDraftTempDir(): Promise<void> {
        if (!(await this.storage.dirExists(DRAFT_ATTACHMENTS_DIR))) {
            await this.storage.mkdir(DRAFT_ATTACHMENTS_DIR);
        }
    }

    private getDraftTempPath(tempId: string): string {
        return path.join(DRAFT_ATTACHMENTS_DIR, safeFileId(tempId));
    }

    private getDraftTempMetaPath(tempId: string): string {
        return `${this.getDraftTempPath(tempId)}.json`;
    }

    async cleanupDraftTemp(tempId: string): Promise<void> {
        const tempPath = this.getDraftTempPath(tempId);
        const metaPath = this.getDraftTempMetaPath(tempId);
        try {
            if (await this.storage.exists(tempPath)) {
                await this.storage.unlink(tempPath);
            }
        } catch {}
        try {
            if (await this.storage.exists(metaPath)) {
                await this.storage.unlink(metaPath);
            }
        } catch {}
        await this.recountStaged();
    }

    async cleanupStaleDraftTemps(): Promise<void> {
        await this.cleanupStaleMaildirTemps();
        if (await this.storage.dirExists(DRAFT_ATTACHMENTS_DIR)) {
            const now = Date.now();
            for (const name of await this.storage.readdir(DRAFT_ATTACHMENTS_DIR)) {
                const filePath = path.join(DRAFT_ATTACHMENTS_DIR, name);
                try {
                    const stat = await this.storage.stat(filePath);
                    if (now - stat.mtimeMs > STALE_DRAFT_TEMP_MAX_AGE_MS) {
                        await this.storage.unlink(filePath);
                    }
                } catch {}
            }
        }
        await this.recountStaged();
    }

    // A crash between a staged write and its rename leaves a file in a mailbox's `tmp/` that no name
    // outside it points at; in standalone mode no Dovecot comes past to sweep it.
    private async cleanupStaleMaildirTemps(): Promise<void> {
        const now = Date.now();
        for (const mailbox of await this.listMailboxPaths()) {
            const tmpDir = path.join(this.mailboxDir(mailbox), PATHS.MAIL.TMP);
            for (const name of await this.storage.list(tmpDir)) {
                const filePath = path.join(tmpDir, name);
                try {
                    const stat = await this.storage.stat(filePath);
                    if (now - stat.mtimeMs > STALE_MAILDIR_TEMP_MAX_AGE_MS) {
                        await this.storage.unlink(filePath);
                    }
                } catch {}
            }
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

        const subscriptions = `${STANDARD_MAILBOXES.filter((m) => m !== MAILBOX_INBOX).join('\n')}\n`;
        await this.storage.writeAtomic(path.join(this.basePath, 'subscriptions'), subscriptions);
    }

    private async mailboxDirExists(mailbox: string): Promise<boolean> {
        return this.storage.dirExists(this.mailboxDir(mailbox));
    }

    // A `.Folder` whose name Eigen cannot address is skipped: Dovecot accepts names this store does not.
    private async listMailboxPaths(): Promise<string[]> {
        const standard: string[] = [];
        for (const name of STANDARD_MAILBOXES) {
            if (await this.mailboxDirExists(name)) standard.push(name);
        }

        const custom: string[] = [];
        for (const entry of await this.storage.readdir(this.basePath, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith('.')) continue;
            const mailbox = entry.name.slice(1);
            if (isStandardMailbox(mailbox) || !isValidMailboxPath(mailbox)) continue;
            custom.push(mailbox);
        }
        return [...standard, ...custom.sort()];
    }

    private async createMailboxDir(mailbox: string): Promise<void> {
        const mailboxPath = this.mailboxDir(mailbox);
        const isInbox = mailbox === MAILBOX_INBOX;
        await this.storage.mkdir(mailboxPath);
        await this.storage.mkdir(path.join(mailboxPath, PATHS.MAIL.CUR));
        await this.storage.mkdir(path.join(mailboxPath, PATHS.MAIL.NEW));
        await this.storage.mkdir(path.join(mailboxPath, PATHS.MAIL.TMP));
        if (!isInbox) {
            await this.storage.write(path.join(mailboxPath, 'maildirfolder'), '');
        }
        await this.storage.syncDir(mailboxPath);
        // The root's entry for the folder: a crash that loses it strands the index rows of a folder no
        // enumeration reaches any more.
        if (!isInbox) await this.storage.syncDir(this.basePath);
    }

    private async deliverAtomic(message: Buffer, mailbox: string, uniqueId: string): Promise<void> {
        const filename = `${uniqueId},S=${message.byteLength}`;
        const mailboxPath = this.mailboxDir(mailbox);

        const tmpPath = path.join(mailboxPath, PATHS.MAIL.TMP, filename);
        await this.storage.writeDurable(tmpPath, message);

        const newPath = path.join(mailboxPath, PATHS.MAIL.NEW, filename);
        await this.storage.renameDurable(tmpPath, newPath);
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

        const tmpPath = path.join(mailboxPath, PATHS.MAIL.TMP, filename);
        await this.storage.writeDurable(tmpPath, message);

        const curPath = path.join(mailboxPath, PATHS.MAIL.CUR, filename);
        await this.storage.renameDurable(tmpPath, curPath);

        return { uniqueId: existingId, size, filename };
    }

    private async moveNewToCur(mailbox: string): Promise<void> {
        const mailboxPath = this.mailboxDir(mailbox);
        const newPath = path.join(mailboxPath, PATHS.MAIL.NEW);
        if (!(await this.storage.dirExists(newPath))) return;

        const curPath = path.join(mailboxPath, PATHS.MAIL.CUR);
        let moved = 0;
        for (const fileName of await this.storage.readdir(newPath)) {
            if (fileName.startsWith('.')) continue;
            const src = path.join(newPath, fileName);
            const curName = fileName.includes(':') ? fileName : `${fileName}:2,`;
            try {
                await this.storage.rename(src, path.join(curPath, curName));
                moved++;
            } catch (e: unknown) {
                if (e instanceof Error && 'code' in e && e.code !== 'ENOENT') throw e;
            }
        }
        // The guarantee is per directory, not per rename, so a cold sync of a large new/ pays one fsync.
        if (moved > 0) await this.storage.syncDir(curPath);
    }

    private async listCurFiles(mailbox: string): Promise<string[]> {
        const curPath = path.join(this.mailboxDir(mailbox), PATHS.MAIL.CUR);
        if (!(await this.storage.dirExists(curPath))) return [];
        return this.storage.readdir(curPath);
    }

    getMessageFile(mailbox: string, filename: string): BunFile {
        const filePath = path.join(this.mailboxDir(mailbox), PATHS.MAIL.CUR, filename);
        return this.storage.file(filePath);
    }

    private async moveMessage(fromMailbox: string, fromFilename: string, toMailbox: string): Promise<void> {
        const srcDir = path.join(this.mailboxDir(fromMailbox), PATHS.MAIL.CUR);
        const dstPath = path.join(this.mailboxDir(toMailbox), PATHS.MAIL.CUR, fromFilename);
        await this.storage.renameDurable(path.join(srcDir, fromFilename), dstPath);
        // Both ends are indexed here: the old name must not come back after the index says it moved.
        await this.storage.syncDir(srcDir);
    }

    private async renameInCur(mailbox: string, oldFilename: string, newFilename: string): Promise<void> {
        const curPath = path.join(this.mailboxDir(mailbox), PATHS.MAIL.CUR);
        await this.storage.renameDurable(path.join(curPath, oldFilename), path.join(curPath, newFilename));
    }

    private async deleteMessage(mailbox: string, filename: string): Promise<void> {
        const curPath = path.join(this.mailboxDir(mailbox), PATHS.MAIL.CUR);
        const filePath = path.join(curPath, filename);
        if (await this.storage.exists(filePath)) {
            await this.storage.unlink(filePath);
            await this.storage.syncDir(curPath);
        }
    }

    // Either delimiter addresses one directory: `Clients/Acme` and `Clients.Acme` are both `.Clients.Acme`.
    private mailboxDir(mailbox: string): string {
        if (mailbox === MAILBOX_INBOX || mailbox === MAILBOX_INBOX_IMAP) return this.basePath;
        if (!isValidMailboxPath(mailbox)) throw new ApiError(400, `Invalid mailbox name: ${mailbox}`);
        return `${this.basePath}/.${mailbox.replaceAll('/', '.')}`;
    }

    // -- Private helpers --

    // A parse/read fault propagates from parseEml — callers must not treat it as "not found".
    private async readAndParse(messageId: string, mailbox: string, filename: string): Promise<Email> {
        return parseEml(messageId, mailbox, this.getMessageFile(mailbox, filename));
    }

    private getMailboxInfo(mailboxName: string): MaildirMailbox {
        return {
            path: mailboxName,
            flags: mailboxListFlags(mailboxName),
            total: this.db.getEmailsCount(mailboxName),
            unread: this.db.getEmailsCountUnread(mailboxName),
        };
    }
}
