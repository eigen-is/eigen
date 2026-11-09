// MaildirStore keeps a user's mail as plain files in the Maildir layout, the same folders the IMAP
// server reads, so Eigen and other mail apps always see the same mail. Next to the files it keeps an
// index database for fast lists and search. The mail part of a Home reads, writes and moves
// messages and drafts through it.

import type { FSWatcher } from 'node:fs';
import * as path from 'node:path';
import {
    isStandardMailbox,
    MAILBOX_DRAFTS,
    MAILBOX_INBOX,
    mailboxListFlags,
    STANDARD_MAILBOXES,
} from '@workspace/lib/constants/mailboxes';
import type { Attachment, DraftAttachmentUpload, Email, EmailSummary, MaildirMailbox } from '@workspace/lib/types/mail';
import type { BunFile, FileSink } from 'bun';
import { Semaphore } from '../../utils/semaphore';
import { isMailAppEnabled } from '../config/env';
import { PATHS } from '../config/paths';
import { ApiError, isEnoent, isSafePathSegment, LocalFilesystem } from '../core';
import type { Home } from '../home';
import { parseEml, parseEmlBytes, parseEmlForReader } from './mail-parse';
import type { MailFlag, MailSearchOptions, MailStoreEvents } from './mail-store';
import MailDB, { readMailIndexSize } from './maildb';
import {
    applyFlagsFromFilename,
    buildMaildirFilename,
    createUniqueMessageId,
    getMailIDfromFileName,
    maildirFolder,
    parseFlagsFromFilename,
    rebuildFlagsSuffix,
} from './mailutils';

// The Maildir spec's own age: a `tmp/` file older than this is a crash leftover, never an in-flight write.
const STALE_MAILDIR_TEMP_MAX_AGE_MS = 36 * 60 * 60 * 1000;
// Every mail SSE event re-lists the mailboxes, so a non-standard folder's listing-kicked reconcile is throttled to this.
const BACKGROUND_RECONCILE_INTERVAL_MS = 60 * 1000;
// Sibling of the Maildir tree (not inside it) so Dovecot IMAP doesn't see it as a folder.
const DRAFT_ATTACHMENTS_DIR = 'draft-attachments';
// A file uploaded for a draft is folded into the draft at its next save: one older than this was abandoned.
const DRAFT_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Staged attachments are charged to the mail quota, and both surfaces that report it walk them here.
function readDraftStagingSize(homeFs: LocalFilesystem): Promise<number> {
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

// Folded to NFC, the rule `isSafePathSegment` assumes, so an accented id names one file and not two. Refused, never
// mapped onto a safe name: two mapped ids would collide on one file.
function safeFileId(id: string): string {
    const name = id.normalize('NFC');
    if (!isSafePathSegment(name)) throw new ApiError(400, `Invalid mail id: ${id}`);
    return name;
}

export class MaildirStore {
    private readonly basePath: string;
    public readonly storage: LocalFilesystem;
    private db!: MailDB;
    private events!: MailStoreEvents;
    private reconcilingMailboxes = new Map<string, Promise<void>>();
    // Mailboxes whose running sync was joined: the joiner's change may land after that pass read the folder.
    private reconcileAgain = new Set<string>();
    private lastReconcileStartedAt = new Map<string, number>();
    // Whether a delivered id was an arrival, read by whichever sync reaches the file first: this append's or a watcher's.
    private deliveries = new Map<string, boolean>();
    // Reconciliation (doReconcileMailbox) must not straddle a mutation's fs+db pair, or its delete phase drops just-moved rows.
    private storeLock = new Semaphore(1);
    // Keyed by watched directory, so a listing can tell which standard folder lost its watcher.
    private watchers = new Map<string, FSWatcher>();
    // size() answers from memory: the quota gate calls it on every metered write, and a walk per call makes an N-card sync O(N²).
    private indexBytes = 0;
    private stagedBytes = 0;

    public constructor(private home: Home) {
        this.basePath = PATHS.MAIL.MAILDIR;
        this.storage = new LocalFilesystem(`${home.homeDir}/${PATHS.MAIL.ROOT}`);
    }

    // -- Lifecycle --

    // True when a fresh, empty store was created.
    public async init(events: MailStoreEvents): Promise<boolean> {
        this.events = events;
        // With mail off the store builds no Maildir and opens no index, yet the mail kept on disk still counts.
        if (!isMailAppEnabled()) {
            this.indexBytes = readMailIndexSize(this.home.fs.absolutePath(PATHS.MAIL.DB));
            await this.recountStaged();
            return false;
        }
        const isNew = !(await this.storage.dirExists(this.basePath));
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

    public async unwatch(): Promise<void> {
        for (const watcher of this.watchers.values()) watcher.close();
        this.watchers.clear();
        // A sync still in flight would reach the db the domain closes next.
        await Promise.allSettled([...this.reconcilingMailboxes.values()]);
    }

    // Watches the standard six, so a change an IMAP client makes reaches the index, and the user, at once.
    // A folder that gets its watcher only now is reconciled once, for what changed while nobody watched it.
    public async watch(): Promise<void> {
        for (const mailbox of STANDARD_MAILBOXES) {
            if (!(await this.watchMailbox(mailbox))) continue;
            this.reconcileMailbox(mailbox).catch((err) => console.error('maildir: mailbox sync failed', err));
        }
    }

    // True when it attached a watcher: a subdir missing last time is retried, and only the caller that attached reconciles.
    private async watchMailbox(mailbox: string): Promise<boolean> {
        let attached = false;
        for (const subdir of [PATHS.MAIL.CUR, PATHS.MAIL.NEW]) {
            const dir = path.join(this.mailboxDir(mailbox), subdir);
            if (this.watchers.has(dir)) continue;
            // Read before the watch attaches, so a dir replaced in between costs a spare re-attach, never a dead watcher.
            const identity = await this.dirIdentity(dir);
            // A listing still in flight during teardown would re-attach what unwatch() just closed.
            if (identity === null || this.home.closing || this.watchers.has(dir)) continue;
            try {
                const watcher = this.storage.watch(dir, () => {
                    this.reconcileMailbox(mailbox).catch((err) => console.error('maildir: mailbox sync failed', err));
                    // inotify leaves a removed dir's handle dead without an error, and a dir recreated since is another dir.
                    this.dirIdentity(dir)
                        .then(async (current) => {
                            if (current === identity || this.watchers.get(dir) !== watcher) return;
                            this.dropWatcher(dir, watcher);
                            if (current === null) return;
                            await this.watchMailbox(mailbox);
                            await this.reconcileMailbox(mailbox);
                        })
                        .catch((err) => console.error('maildir: watcher check failed', err));
                });
                watcher.on('error', () => this.dropWatcher(dir, watcher));
                this.watchers.set(dir, watcher);
                attached = true;
            } catch {
                // Removed between the stat and the watch
            }
        }
        return attached;
    }

    private dropWatcher(dir: string, watcher: FSWatcher): void {
        watcher.close();
        if (this.watchers.get(dir) === watcher) this.watchers.delete(dir);
    }

    // Linux hands a removed dir's inode number to the next dir created, so the birth time tells the two apart.
    private dirIdentity(dir: string): Promise<string | null> {
        return this.storage.stat(dir).then(
            (stats) => `${stats.ino}:${stats.birthtimeMs}`,
            () => null,
        );
    }

    public async destruct(): Promise<void> {
        // init() can throw before the db opens, and the home destructs regardless.
        if (this.db) {
            await this.db.destruct();
        }
    }

    public async size(): Promise<number> {
        return this.indexBytes + this.stagedBytes;
    }

    // The staging dir holds one compose session at most, so a re-walk is free and, unlike a running delta, cannot drift.
    private async recountStaged(): Promise<void> {
        this.stagedBytes = await readDraftStagingSize(this.home.fs);
    }

    public search(opts: MailSearchOptions): EmailSummary[] {
        return this.db.searchMail(opts);
    }

    // -- Mailbox operations --

    public async mailboxesList(): Promise<MaildirMailbox[]> {
        const mailboxes: MaildirMailbox[] = [];
        // Also gives a standard folder that was recreated since its watcher back.
        await this.watch();
        const paths = await this.listMailboxPaths();
        for (const name of paths) {
            // Counts come from the index. A folder outside the standard six has no watcher, because each one
            // spends the per-user inotify limit that every home shares. It reconciles here instead.
            const lastSync = this.lastReconcileStartedAt.get(name) ?? 0;
            if (!isStandardMailbox(name) && Date.now() - lastSync >= BACKGROUND_RECONCILE_INTERVAL_MS) {
                this.reconcileMailbox(name).catch((err) =>
                    console.error('maildir: background mailbox sync failed', err),
                );
            }
            mailboxes.push(this.getMailboxInfo(name, paths));
        }
        return mailboxes;
    }

    public async listMessages(
        mailbox: string,
        opts: { limit: number; before?: { date: Date; id: string } },
    ): Promise<EmailSummary[]> {
        if (!(await this.mailboxExists(mailbox))) {
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

    public getSummary(messageId: string): EmailSummary | undefined {
        return this.db.getEmail(messageId);
    }

    public unreadCount(mailbox: string): number {
        return this.db.getEmailsCountUnread(mailbox);
    }

    // null means no such message, which includes a file a mail client renamed or removed before the next sync caught the
    // row up. Any other parse, read or DB fault propagates rather than masking as a missing message.
    public async getMessage(messageId: string): Promise<Email | null> {
        const cached = this.db.getEmail(messageId);
        if (!cached) return null;

        const parsed = await parseEmlForReader(
            messageId,
            cached.mailbox,
            this.getMessageFile(cached.mailbox, cached.filename),
            cached.isDraft,
        ).catch((e: unknown) => {
            if (isEnoent(e)) return null;
            throw e;
        });
        if (!parsed) return null;
        applyFlagsFromFilename(parsed, cached.filename);
        return { ...parsed, ...cached };
    }

    public async getRawMessage(messageId: string): Promise<ArrayBuffer> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Email '${messageId}' not found`);
        return this.getMessageFile(email.mailbox, email.filename).arrayBuffer();
    }

    public async getAttachments(messageId: string): Promise<Attachment[]> {
        const email = this.db.getEmail(messageId);
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`);
        return (await parseEml(messageId, email.mailbox, this.getMessageFile(email.mailbox, email.filename)))
            .attachments;
    }

    // skipReconcile leaves discovery to the next pass. arrival: false is a message the user placed there, indexed and
    // broadcast but not mail arriving, so it reaches `received` as not new.
    public async append(
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

    public async saveDraft(bytes: Buffer, messageId: string): Promise<Email> {
        // Parsed off the lock: these bytes are exactly what parseEml would read back from the delivered file.
        const parsed: Email = parseEmlBytes(messageId, MAILBOX_DRAFTS, bytes);

        // The file write and the row stay one step, or a watcher sync ingests the draft first and fires a spurious received.
        return this.storeLock.run(async () => {
            const replaced = this.db.getEmail(messageId);
            // A stale tab or a replayed send names a message that has left Drafts: saving it would take it out of Sent.
            if (replaced && !replaced.isDraft) throw new ApiError(409, 'This message is no longer a draft');

            // Straight into cur/: Eigen placed it there itself, with the flags already in the name. Dovecot keys a UID on the
            // name before the `:`, so the stamp makes every save a new message to IMAP, even one that keeps the byte size.
            const filename = buildMaildirFilename(
                `${messageId},M=${crypto.randomUUID()}`,
                { draft: true, seen: true },
                bytes.byteLength,
            );
            await this.deliver(MAILBOX_DRAFTS, PATHS.MAIL.CUR, filename, bytes);

            applyFlagsFromFilename(parsed, filename);
            parsed.filename = filename;
            parsed.mailbox = MAILBOX_DRAFTS;
            this.db.insertEmails([parsed]);
            this.indexBytes += parsed.size - (replaced?.size ?? 0);
            // The old file goes last, so a crash leaves the draft twice and never not at all. A sync keeps the newer.
            if (replaced) {
                await this.storage.unlinkDurable(
                    path.join(this.mailboxDir(replaced.mailbox), PATHS.MAIL.CUR, replaced.filename),
                );
            }
            return parsed;
        });
    }

    public async delete(messageId: string): Promise<void> {
        return this.storeLock.run(async () => {
            const email = this.db.getEmail(messageId);
            if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

            await this.storage.unlinkDurable(path.join(this.mailboxDir(email.mailbox), PATHS.MAIL.CUR, email.filename));
            this.db.deleteEmail(messageId);
            this.indexBytes -= email.size;
        });
    }

    public async move(messageId: string, targetMailbox: string): Promise<void> {
        return this.storeLock.run(async () => {
            const email = this.db.getEmail(messageId);
            if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

            if (!(await this.mailboxExists(targetMailbox))) {
                throw new ApiError(404, `Target mailbox '${targetMailbox}' not found`);
            }

            // Both ends are indexed here: the old name must not come back after the index says it moved.
            await this.storage.moveDurable(
                path.join(this.mailboxDir(email.mailbox), PATHS.MAIL.CUR, email.filename),
                path.join(this.mailboxDir(targetMailbox), PATHS.MAIL.CUR, email.filename),
            );
            this.db.moveEmail(messageId, targetMailbox);
        });
    }

    public async setFlags(messageId: string, changes: Partial<Record<MailFlag, boolean>>): Promise<void> {
        return this.storeLock.run(async () => {
            const email = this.db.getEmail(messageId);
            if (!email) throw new ApiError(404, `Message '${messageId}' not found`);

            const newFlagStr = rebuildFlagsSuffix(email.filename, changes);
            const uniqueWithSize = email.filename.split(':')[0];
            const newFilename = `${uniqueWithSize}:2,${newFlagStr}`;

            if (newFilename !== email.filename) {
                const cur = path.join(this.mailboxDir(email.mailbox), PATHS.MAIL.CUR);
                await this.storage.renameDurable(path.join(cur, email.filename), path.join(cur, newFilename));
            }

            // The row mirrors the filename's letters, so no flag can be written to one and not the other.
            const flags = parseFlagsFromFilename(newFilename);
            this.db.updateFlags(
                messageId,
                { isRead: flags.seen, isFlagged: flags.flagged, isDraft: flags.draft, isReplied: flags.replied },
                newFilename,
            );
        });
    }

    // -- Sync --

    private async reconcileMailbox(mailbox: string): Promise<void> {
        // A watcher's fire-and-forget sync started during teardown would query a closed db.
        if (this.home.closing) return;
        this.lastReconcileStartedAt.set(mailbox, Date.now());
        const running = this.reconcilingMailboxes.get(mailbox);
        if (running) {
            this.reconcileAgain.add(mailbox);
            return running;
        }

        // Cleared inside the lock, so a caller that joins a pass still waiting for the lock costs no extra one.
        const promise = (async () => {
            try {
                do {
                    await this.storeLock.run(() => {
                        this.reconcileAgain.delete(mailbox);
                        return this.doReconcileMailbox(mailbox);
                    });
                } while (this.reconcileAgain.has(mailbox) && !this.home.closing);
            } finally {
                // In the same turn as the last check, so nobody joins a loop that already ended.
                this.reconcilingMailboxes.delete(mailbox);
            }
        })();
        this.reconcilingMailboxes.set(mailbox, promise);
        return promise;
    }

    private async doReconcileMailbox(mailbox: string): Promise<void> {
        await this.moveNewToCur(mailbox);

        const diskFiles = new Map<string, string>();
        const curPath = path.join(this.mailboxDir(mailbox), PATHS.MAIL.CUR);
        const curFiles = (await this.storage.dirExists(curPath)) ? await this.storage.readdir(curPath) : [];
        for (const fileName of curFiles) {
            if (fileName.startsWith('.')) continue;
            const id = getMailIDfromFileName(fileName);
            const sameId = diskFiles.get(id);
            diskFiles.set(
                id,
                sameId && mailbox === MAILBOX_DRAFTS ? await this.keepNewerDraftFile(sameId, fileName) : fileName,
            );
        }

        const dbRecords = this.db.listReconcileRows(mailbox);
        const dbById = new Map(dbRecords.map((r) => [r.id, r]));
        // A mailbox with no rows yet is indexed for the first time: what it finds was discovered, not delivered.
        const indexed = dbRecords.length > 0;

        // Inserts are batched because one insert per message dominates a cold index, and `received` waits on the commit.
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

    // Left behind, the older file could win a later pass over every save after it, and come back after a send or a
    // delete. A name a rename just retired stats as absent, so its live twin wins.
    private async keepNewerDraftFile(a: string, b: string): Promise<string> {
        const cur = path.join(this.mailboxDir(MAILBOX_DRAFTS), PATHS.MAIL.CUR);
        const modified = (name: string) =>
            this.storage.stat(path.join(cur, name)).then(
                (stats) => stats.mtimeMs,
                () => 0,
            );
        const [newer, older] = (await modified(a)) > (await modified(b)) ? [a, b] : [b, a];
        await this.storage.unlinkDurable(path.join(cur, older));
        return newer;
    }

    // -- Draft temp staging --

    public async persistDraftTemp(
        write: (writer: FileSink) => Promise<number>,
        filename: string,
        contentType: string,
    ): Promise<DraftAttachmentUpload> {
        if (!(await this.storage.dirExists(DRAFT_ATTACHMENTS_DIR))) {
            await this.storage.mkdir(DRAFT_ATTACHMENTS_DIR);
        }
        const tempId = crypto.randomUUID();
        const writer = this.storage.file(this.getDraftTempPath(tempId)).writer({ highWaterMark: 256 * 1024 });
        let size: number;
        try {
            size = await write(writer);
            await writer.end();
        } catch (e) {
            try {
                await writer.end();
            } catch {}
            await this.cleanupDraftTemp(tempId);
            throw e;
        }
        const meta = { filename, size, contentType };
        try {
            await this.storage.write(this.getDraftTempMetaPath(tempId), JSON.stringify(meta));
        } catch (e) {
            await this.cleanupDraftTemp(tempId);
            throw e;
        }
        await this.recountStaged();
        return { tempId, ...meta };
    }

    public async readDraftTempFile(
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

    private getDraftTempPath(tempId: string): string {
        return path.join(DRAFT_ATTACHMENTS_DIR, safeFileId(tempId));
    }

    private getDraftTempMetaPath(tempId: string): string {
        return `${this.getDraftTempPath(tempId)}.json`;
    }

    public async cleanupDraftTemp(tempId: string): Promise<void> {
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

    public async cleanupStaleDraftTemps(): Promise<void> {
        await this.cleanupStaleMaildirTemps();
        if (await this.storage.dirExists(DRAFT_ATTACHMENTS_DIR)) {
            const now = Date.now();
            for (const name of await this.storage.readdir(DRAFT_ATTACHMENTS_DIR)) {
                const filePath = path.join(DRAFT_ATTACHMENTS_DIR, name);
                try {
                    const stat = await this.storage.stat(filePath);
                    if (now - stat.mtimeMs > DRAFT_ATTACHMENT_MAX_AGE_MS) {
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

    private async createStandardMailboxes(): Promise<void> {
        for (const mailbox of STANDARD_MAILBOXES) {
            if (!(await this.storage.dirExists(this.mailboxDir(mailbox)))) {
                await this.createMailboxDir(mailbox);
            }
        }

        const subscriptions = `${STANDARD_MAILBOXES.filter((m) => m !== MAILBOX_INBOX).join('\n')}\n`;
        await this.storage.writeAtomic(path.join(this.basePath, 'subscriptions'), subscriptions);
    }

    public async mailboxExists(mailbox: string): Promise<boolean> {
        return this.storage.dirExists(this.mailboxDir(mailbox));
    }

    // A `.Folder` whose name Eigen cannot address is skipped: Dovecot accepts names this store does not.
    private async listMailboxPaths(): Promise<string[]> {
        const standard: string[] = [];
        for (const name of STANDARD_MAILBOXES) {
            if (await this.mailboxExists(name)) standard.push(name);
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

    public getMessageFile(mailbox: string, filename: string): BunFile {
        const filePath = path.join(this.mailboxDir(mailbox), PATHS.MAIL.CUR, filename);
        return this.storage.file(filePath);
    }

    private mailboxDir(mailbox: string): string {
        if (!isValidMailboxPath(mailbox)) throw new ApiError(400, `Invalid mailbox name: ${mailbox}`);
        return maildirFolder(this.basePath, mailbox);
    }

    private getMailboxInfo(mailboxName: string, allMailboxes: readonly string[]): MaildirMailbox {
        return {
            path: mailboxName,
            flags: mailboxListFlags(mailboxName, allMailboxes),
            total: this.db.getEmailsCount(mailboxName),
            unread: this.db.getEmailsCountUnread(mailboxName),
        };
    }
}
