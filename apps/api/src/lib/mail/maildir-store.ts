import type { FSWatcher } from 'node:fs';
import type { BunFile } from 'bun';
import { ApiError, LocalFilesystem, PATHS, STANDARD_MAILBOXES } from '../core';
import { buildMaildirFilename, createUniqueMessageId } from './mailutils';

export class MaildirStore {
    readonly basePath: string;
    readonly storage: LocalFilesystem;
    private watchers: FSWatcher[] = [];
    private readonly CUR: string;
    private readonly NEW: string;
    private readonly TMP: string;

    constructor(homeDir: string) {
        const { ROOT, MAILDIR, CUR, NEW, TMP } = PATHS.MAIL;
        this.basePath = MAILDIR;
        this.storage = new LocalFilesystem(`${homeDir}/${ROOT}`);
        this.CUR = CUR;
        this.NEW = NEW;
        this.TMP = TMP;
    }

    openDraftTempWriter(tempId: string) {
        return this.storage.file(this.getDraftTempPath(tempId)).writer({ highWaterMark: 256 * 1024 });
    }

    async writeDraftTempMeta(
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
        const meta = (await metaFile.exists())
            ? ((await metaFile.json()) as { filename: string; contentType: string })
            : { filename: tempId, contentType: 'application/octet-stream' };
        return {
            content: Buffer.from(await file.arrayBuffer()),
            filename: meta.filename,
            contentType: meta.contentType,
        };
    }

    async exists(): Promise<boolean> {
        return this.storage.dirExists(this.basePath);
    }

    async createStandardMailboxes(): Promise<void> {
        for (const mailbox of STANDARD_MAILBOXES) {
            if (!(await this.storage.dirExists(this.mailboxDir(mailbox)))) {
                await this.createMailboxDir(mailbox);
            }
        }

        const subscriptions = `${STANDARD_MAILBOXES.filter((m) => m !== '').join('\n')}\n`;
        await this.storage.write(this.storage.pathJoin(this.basePath, 'subscriptions'), subscriptions);
    }

    getDraftTempDir(): string {
        // Sibling of the Maildir tree (not inside it) so Dovecot IMAP doesn't see it as a folder.
        return 'draft-attachments';
    }

    async ensureDraftTempDir(): Promise<void> {
        const dir = this.getDraftTempDir();
        if (!(await this.storage.dirExists(dir))) {
            await this.storage.mkdir(dir);
        }
    }

    private sanitizeTempId(tempId: string): string {
        return tempId.replace(/[^a-zA-Z0-9-_]/g, '_');
    }

    getDraftTempPath(tempId: string): string {
        return this.storage.pathJoin(this.getDraftTempDir(), this.sanitizeTempId(tempId));
    }

    getDraftTempMetaPath(tempId: string): string {
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

    async cleanupStaleDraftTemps(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
        const dir = this.getDraftTempDir();
        if (!(await this.storage.dirExists(dir))) return;
        const now = Date.now();
        for (const name of await this.storage.readdir(dir)) {
            const filePath = this.storage.pathJoin(dir, name);
            try {
                const stat = await this.storage.stat(filePath);
                if (now - stat.mtimeMs > maxAgeMs) {
                    await this.storage.unlink(filePath);
                }
            } catch {}
        }
    }

    // -- Draft meta sidecar (lightweight body-only saves) --

    getDraftMetaPath(draftId: string): string {
        return this.storage.pathJoin('draft-meta', `${this.sanitizeTempId(draftId)}.json`);
    }

    async ensureDraftMetaDir(): Promise<void> {
        if (!(await this.storage.dirExists('draft-meta'))) {
            await this.storage.mkdir('draft-meta');
        }
    }

    async writeDraftMeta(draftId: string, meta: Record<string, unknown>): Promise<void> {
        await this.ensureDraftMetaDir();
        await this.storage.write(this.getDraftMetaPath(draftId), JSON.stringify(meta));
    }

    async readDraftMeta<T = Record<string, unknown>>(draftId: string): Promise<T | null> {
        const path = this.getDraftMetaPath(draftId);
        if (!(await this.storage.fileExists(path))) return null;
        return (await this.storage.file(path).json()) as T;
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
        if (!(await this.storage.dirExists('draft-meta'))) return [];
        const files = await this.storage.readdir('draft-meta');
        return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    }

    async mailboxDirExists(mailbox: string): Promise<boolean> {
        return this.storage.dirExists(this.mailboxDir(mailbox));
    }

    async createMailboxDir(mailbox: string): Promise<void> {
        const mailboxPath = this.mailboxDir(mailbox);
        await this.storage.mkdir(mailboxPath);
        await this.storage.mkdir(this.storage.pathJoin(mailboxPath, this.CUR));
        await this.storage.mkdir(this.storage.pathJoin(mailboxPath, this.NEW));
        await this.storage.mkdir(this.storage.pathJoin(mailboxPath, this.TMP));
        if (mailbox !== '') {
            await this.storage.write(this.storage.pathJoin(mailboxPath, 'maildirfolder'), '');
        }
    }

    async deliverAtomic(message: string, mailbox: string): Promise<{ uniqueId: string; size: number }> {
        const uniqueId = createUniqueMessageId();
        const size = Buffer.byteLength(message, 'utf-8');
        const filename = `${uniqueId},S=${size}`;
        const mailboxPath = this.mailboxDir(mailbox);

        const tmpPath = this.storage.pathJoin(mailboxPath, this.TMP, filename);
        await this.storage.write(tmpPath, message);

        const newPath = this.storage.pathJoin(mailboxPath, this.NEW, filename);
        await this.storage.rename(tmpPath, newPath);

        return { uniqueId, size };
    }

    async deliverToCur(
        mailbox: string,
        message: string,
        flags: Record<string, boolean>,
        existingId?: string,
    ): Promise<{
        uniqueId: string;
        size: number;
        filename: string;
    }> {
        const uniqueId = existingId ?? createUniqueMessageId();
        const size = Buffer.byteLength(message, 'utf-8');
        const filename = buildMaildirFilename(uniqueId, flags, size);
        const mailboxPath = this.mailboxDir(mailbox);

        const tmpPath = this.storage.pathJoin(mailboxPath, this.TMP, filename);
        await this.storage.write(tmpPath, message);

        const curPath = this.storage.pathJoin(mailboxPath, this.CUR, filename);
        await this.storage.rename(tmpPath, curPath);

        return { uniqueId, size, filename };
    }

    async moveNewToCur(mailbox: string): Promise<void> {
        const mailboxPath = this.mailboxDir(mailbox);
        const newPath = this.storage.pathJoin(mailboxPath, this.NEW);
        if (!(await this.storage.dirExists(newPath))) return;

        for (const fileName of await this.storage.readdir(newPath)) {
            if (fileName.startsWith('.')) continue;
            const src = this.storage.pathJoin(newPath, fileName);
            const curName = fileName.includes(':') ? fileName : `${fileName}:2,`;
            const dst = this.storage.pathJoin(mailboxPath, this.CUR, curName);
            try {
                await this.storage.rename(src, dst);
            } catch (e: unknown) {
                if (e instanceof Error && 'code' in e && e.code !== 'ENOENT') throw e;
            }
        }
    }

    async listCurFiles(mailbox: string): Promise<string[]> {
        const curPath = this.storage.pathJoin(this.mailboxDir(mailbox), this.CUR);
        if (!(await this.storage.dirExists(curPath))) return [];
        return this.storage.readdir(curPath);
    }

    getMessageFile(mailbox: string, filename: string): BunFile {
        const filePath = this.storage.pathJoin(this.mailboxDir(mailbox), this.CUR, filename);
        return this.storage.file(filePath);
    }

    async moveMessage(fromMailbox: string, fromFilename: string, toMailbox: string): Promise<void> {
        const srcPath = this.storage.pathJoin(this.mailboxDir(fromMailbox), this.CUR, fromFilename);
        const dstPath = this.storage.pathJoin(this.mailboxDir(toMailbox), this.CUR, fromFilename);
        await this.storage.rename(srcPath, dstPath);
    }

    async renameInCur(mailbox: string, oldFilename: string, newFilename: string): Promise<void> {
        const curPath = this.storage.pathJoin(this.mailboxDir(mailbox), this.CUR);
        await this.storage.rename(
            this.storage.pathJoin(curPath, oldFilename),
            this.storage.pathJoin(curPath, newFilename),
        );
    }

    async deleteMessage(mailbox: string, filename: string): Promise<void> {
        const filePath = this.storage.pathJoin(this.mailboxDir(mailbox), this.CUR, filename);
        if (await this.storage.fileExists(filePath)) {
            await this.storage.unlink(filePath);
        }
    }

    async findFileByUniqueId(uniqueId: string, mailbox: string): Promise<string | undefined> {
        const files = await this.listCurFiles(mailbox);
        return files.find((f) => f.startsWith(uniqueId));
    }

    async dirSize(): Promise<number> {
        return (await this.storage.dirSize(PATHS.MAIL.ROOT)) || 0;
    }

    watchMailboxes(onChange: (mailbox: string) => void): void {
        for (const mailbox of STANDARD_MAILBOXES) {
            const mailboxPath = this.mailboxDir(mailbox);
            for (const subdir of [this.CUR, this.NEW]) {
                try {
                    const watcher = this.storage.watch(this.storage.pathJoin(mailboxPath, subdir), () =>
                        onChange(mailbox),
                    );
                    this.watchers.push(watcher);
                } catch {
                    // Directory may not exist yet
                }
            }
        }
    }

    unwatchMailboxes(): void {
        for (const watcher of this.watchers) watcher.close();
        this.watchers = [];
    }

    private mailboxDir(mailbox: string): string {
        if (mailbox === '' || mailbox === 'INBOX') return this.basePath;
        if (/[^a-zA-Z0-9._\- /]/.test(mailbox) || mailbox.includes('..')) {
            throw new ApiError(400, `Invalid mailbox name: ${mailbox}`);
        }
        return `${this.basePath}/.${mailbox.replace('/', '.')}`;
    }
}
