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
import { ApiError, isEnoent, isSafePathSegment, LocalFilesystem, PATHS } from '../core';
import type { Home } from '../home';
import { parseEml, parseEmlBytes, parseEmlForReader } from './mail-parse';
import type { DraftMeta, MailFlag, MailSearchOptions, MailStore, MailStoreEvents } from './mail-store';
import MailDB, { readMailIndexSize } from './maildb';
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
// Every mail SSE event re-lists the mailboxes, so a non-standard folder's listing-kicked reconcile is throttled to this.
const BACKGROUND_RECONCILE_INTERVAL_MS = 60 * 1000;
// Sibling of the Maildir tree (not inside it) so Dovecot IMAP doesn't see it as a folder.
const DRAFT_ATTACHMENTS_DIR = 'draft-attachments';

// Staged attachments are charged to the mail quota, and both surfaces that report it walk them here.
export function readDraftStagingSize(homeFs: LocalFilesystem): Promise<number> {
    return homeFs.dirSize(path.join(PATHS.MAIL.ROOT, DRAFT_ATTACHMENTS_DIR));
}

// The admin usage view reads this for a Home nobody booted, so it must count exactly what `MaildirStore.size()` counts.
export async function readMailTotalSize(homeFs: LocalFilesystem): Promise<number> {
    return readMailIndexSize(homeFs.absolutePath(PATHS.MAIL.DB)) + (await readDraftStagingSize(homeFs));
}

// Dovecot spells non-ASCII folder names in modified UTF-7 (`Ärger` is `.&AMQ-rger`), so the rule bans path breakage, not characters.
const MAILBOX_SEGMENT_MAX_CHARS = 200;
const CONTROL_CHARACTER = /\p{Cc}/u;

function isValidMailboxPath(mailbox: string): boolean {
    return mailbox
        .split(/[./]/)
        .every(
            (segment) =>
                segment.length > 0 &&
                segment.length <= MAILBOX_SEGMENT_MAX_CHARS &&
                !CONTROL_CHARACTER.test(segment) &&
                segment.trim() === segment,
        );
}

// The NFC fold `isSafePathSegment` assumes, so an accented id names one file and not two. Null for a name
// no Eigen id could have, which a read treats as absent where a write refuses it.
function foldFileId(id: string): string | null {
    const name = id.normalize('NFC');
    return isSafePathSegment(name) ? name : null;
}

// Refused, never mapped onto a safe name: two mapped ids would collide on one file.
function safeFileId(id: string): string {
    const name = foldFileId(id);
    if (!name) throw new ApiError(400, `Invalid mail id: ${id}`);
    return name;
}

export class MaildirStore implements MailStore {
    readonly basePath: string;
    readonly storage: LocalFilesystem;
    private db!: MailDB;
    private events!: MailStoreEvents;
    private reconcilingMailboxes = new Map<string, Promise<void>>();
    private lastReconcileStartedAt = new Map<string, number>();
    // Whether a delivered id was an arrival, read by whichever sync reaches the file first: this append's or a watcher's.
    private deliveries = new Map<string, boolean>();
    // Reconciliation (doReconcileMailbox) must not straddle a mutation's fs+db pair, or its delete phase drops just-moved rows.
    private storeLock = new Semaphore(1);
    private watchers: FSWatcher[] = [];
    // size() answers from memory: the quota gate calls it on every metered write, and a walk per call makes an N-card sync O(N²).
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

    // The standard six only: a watcher per IMAP folder spends the per-user inotify limit every home shares.
    watch(): void {
        for (const mailbox of STANDARD_MAILBOXES) {
            const mailboxPath = this.mailboxDir(mailbox);
            for (const subdir of [PATHS.MAIL.CUR, PATHS.MAIL.NEW]) {
                try {
                    const watcher = this.storage.watch(path.join(mailboxPath, subdir), () =>
                        this.reconcileMailbox(mailbox).catch((err) =>
                            console.error('maildir: mailbox sync failed', err),
                        ),
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
        // A sync still in flight would reach a closed db once the domain flushes drafts.
        await Promise.allSettled([...this.reconcilingMailboxes.values()]);
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

    // The staging dir holds one compose session at most, so a re-walk is free and, unlike a running delta, cannot drift.
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
            // Counts come from the index; a folder without a watcher reconciles here, in the background.
            if (!isStandardMailbox(name) && this.reconcileDue(name)) {
                this.reconcileMailbox(name).catch((err) =>
                    console.error('maildir: background mailbox sync failed', err),
                );
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
        // Only the first open blocks: afterwards the DB answers at once and the sync's SSE events carry what changed.
        if (this.db.getEmailsCount(mailbox) === 0) {
            await this.reconcileMailbox(mailbox);
        } else {
            this.reconcileMailbox(mailbox).catch((err) =>
                console.error('maildir: background mailbox sync failed', err),
            );
        }
        return this.db.listMessages(mailbox, opts);
    }

    // -- Message operations --

    getSummary(messageId: string): EmailSummary | undefined {
        return this.db.getEmail(messageId);
    }

    // null means "no summary row" only: a parse, read or DB fault propagates rather than masking as a missing message.
    async getMessage(messageId: string): Promise<Email | null> {
        const cached = this.db.getEmail(messageId);
        if (!cached) return null;

        const parsed = await parseEmlForReader(
            messageId,
            cached.mailbox,
            this.getMessageFile(cached.mailbox, cached.filename),
        );
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
        const parsed = await parseEml(messageId, email.mailbox, this.getMessageFile(email.mailbox, email.filename));
        return parsed.attachments;
    }

    async append(
        mailbox: string,
        message: Buffer,
        opts?: { skipReconcile?: boolean; arrival?: boolean },
    ): Promise<string> {
        const uniqueId = createUniqueMessageId();
        // Recorded before the file lands: a watcher-driven sync can reach it first and must find the flag.
        this.deliveries.set(uniqueId, opts?.arrival ?? true);
        try {
            // Lock covers only the delivery — the follow-up reconcile takes the lock itself.
            await this.storeLock.run(() =>
                this.deliver(mailbox, PATHS.MAIL.NEW, `${uniqueId},S=${message.byteLength}`, message),
            );
        } catch (e) {
            this.deliveries.delete(uniqueId);
            throw e;
        }
        if (!opts?.skipReconcile) await this.reconcileMailbox(mailbox);
        return uniqueId;
    }

    async saveDraft(raw: string, existingId?: string): Promise<Email> {
        // Parsed off the lock: these bytes are exactly what parseEml would read back from the delivered file.
        const messageId = existingId ?? createUniqueMessageId();
        const bytes = Buffer.from(raw, 'utf-8');
        const parsed = await parseEmlBytes(messageId, MAILBOX_DRAFTS, bytes, bytes.length);

        // The file write and the row stay one step, or a watcher sync ingests the draft first and fires a spurious received.
        return this.storeLock.run(async () => {
            // Straight into cur/: Eigen placed it there itself, with the flags already in the name.
            const filename = buildMaildirFilename(messageId, { draft: true, seen: true }, bytes.byteLength);
            await this.deliver(MAILBOX_DRAFTS, PATHS.MAIL.CUR, filename, bytes);

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

            await this.storage.unlinkDurable(path.join(this.mailboxDir(email.mailbox), PATHS.MAIL.CUR, email.filename));
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
        const last = this.lastReconcileStartedAt.get(mailbox);
        return last === undefined || Date.now() - last >= BACKGROUND_RECONCILE_INTERVAL_MS;
    }

    private async reconcileMailbox(mailbox: string): Promise<void> {
        // A watcher's fire-and-forget sync started during teardown would query a closed db.
        if (this.home.destructing) return;
        this.lastReconcileStartedAt.set(mailbox, Date.now());
        const running = this.reconcilingMailboxes.get(mailbox);
        if (running) return running;

        const promise = this.storeLock.run(() => this.doReconcileMailbox(mailbox));
        this.reconcilingMailboxes.set(mailbox, promise);
        try {
            await promise;
        } finally {
            this.reconcilingMailboxes.delete(mailbox);
        }
    }

    private async doReconcileMailbox(mailbox: string): Promise<void> {
        await this.moveNewToCur(mailbox);

        const diskFiles = new Map<string, string>();
        for (const fileName of await this.listCurFiles(mailbox)) {
            if (!fileName.startsWith('.')) {
                diskFiles.set(getMailIDfromFileName(fileName), fileName);
            }
        }

        const dbRecords = this.db.listReconcileRows(mailbox);
        const dbById = new Map(dbRecords.map((r) => [r.id, r]));
        // A mailbox with no rows yet is indexed for the first time: what it finds was discovered, not delivered.
        const indexed = dbRecords.length > 0;

        // Batched inserts are the biggest cold-index win (addEmail was ~71% of a 92 s sync of 100k), and `received` waits on the commit.
        const NEW_CHUNK = 250;
        const newEntries = [...diskFiles].filter(([id]) => !dbById.has(id));
        for (let i = 0; i < newEntries.length; i += NEW_CHUNK) {
            const chunk = newEntries.slice(i, i + NEW_CHUNK);
            // events.received needs the full parse (`from`) for the notification, while insertEmails reads only the summary.
            const parsed: Email[] = [];
            for (const [id, fileName] of chunk) {
                // One unreadable .eml must not drop the rest of the chunk, and an ENOENT is a benign mid-sync race.
                try {
                    const file = this.getMessageFile(mailbox, fileName);
                    const p = await parseEml(id, mailbox, file);
                    applyFlagsFromFilename(p, fileName);
                    p.filename = fileName;
                    parsed.push(p);
                } catch (e: unknown) {
                    this.deliveries.delete(id);
                    if (!isEnoent(e))
                        console.warn(
                            `reconcileMailbox: failed to parse ${fileName}:`,
                            e instanceof Error ? e.message : e,
                        );
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

    // Takes the folded name, so a caller's gate and the sidecar it names can never disagree.
    private getDraftMetaPath(name: string): string {
        return path.join(this.getDraftMetaDir(), `${name}.json`);
    }

    async writeDraftMeta(draftId: string, meta: DraftMeta): Promise<void> {
        await this.storage.writeAtomic(this.getDraftMetaPath(safeFileId(draftId)), JSON.stringify(meta));
    }

    async readDraftMeta(draftId: string): Promise<DraftMeta | null> {
        // Another MDA's filename can hold characters no Eigen id has: no sidecar exists for it, and it must not fail the sync.
        const name = foldFileId(draftId);
        if (!name) return null;
        const metaPath = this.getDraftMetaPath(name);
        if (!(await this.storage.exists(metaPath))) return null;
        try {
            return await this.storage.file(metaPath).json();
        } catch {
            // Torn bytes from a crash read as absent, so the caller falls back to the .eml.
            return null;
        }
    }

    async deleteDraftMeta(draftId: string): Promise<void> {
        // No sidecar can exist under an id Eigen did not mint.
        const name = foldFileId(draftId);
        if (!name) return;
        const metaPath = this.getDraftMetaPath(name);
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
        // The sidecars are written through writeAtomic, and nothing else passes that directory.
        await this.storage.sweepAtomicTemps(this.getDraftMetaDir());
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

    // A crash between a staged write and its rename strands a `tmp/` file, and standalone mode has no Dovecot to sweep it.
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
        // A crash that loses the root's entry for the folder strands the index rows of a folder no enumeration reaches.
        if (!isInbox) await this.storage.syncDir(this.basePath);
    }

    // Maildir delivery: staged in `tmp/` and fsynced, then renamed into `new` for an arrival or `cur` for Eigen's own write.
    private async deliver(mailbox: string, subdir: 'new' | 'cur', filename: string, bytes: Buffer): Promise<void> {
        const mailboxPath = this.mailboxDir(mailbox);
        const tmpPath = path.join(mailboxPath, PATHS.MAIL.TMP, filename);
        await this.storage.writeDurable(tmpPath, bytes);
        await this.storage.renameDurable(tmpPath, path.join(mailboxPath, subdir, filename));
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
                // A message another sync already moved is gone, not a failure; anything else fails the pass.
                if (!isEnoent(e)) throw e;
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
        // Both ends are indexed here: the old name must not come back after the index says it moved.
        await this.storage.moveDurable(path.join(srcDir, fromFilename), dstPath);
    }

    private async renameInCur(mailbox: string, oldFilename: string, newFilename: string): Promise<void> {
        const curPath = path.join(this.mailboxDir(mailbox), PATHS.MAIL.CUR);
        await this.storage.renameDurable(path.join(curPath, oldFilename), path.join(curPath, newFilename));
    }

    // Either delimiter addresses one directory: `Clients/Acme` and `Clients.Acme` are both `.Clients.Acme`.
    private mailboxDir(mailbox: string): string {
        if (mailbox === MAILBOX_INBOX || mailbox === MAILBOX_INBOX_IMAP) return this.basePath;
        if (!isValidMailboxPath(mailbox)) throw new ApiError(400, `Invalid mailbox name: ${mailbox}`);
        return `${this.basePath}/.${mailbox.replaceAll('/', '.')}`;
    }

    // -- Private helpers --

    private getMailboxInfo(mailboxName: string): MaildirMailbox {
        return {
            path: mailboxName,
            flags: mailboxListFlags(mailboxName),
            total: this.db.getEmailsCount(mailboxName),
            unread: this.db.getEmailsCountUnread(mailboxName),
        };
    }
}
