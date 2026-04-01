import type { FSWatcher } from 'node:fs';
import type { BunFile } from 'bun';
import { LocalFilesystem, PATHS, STANDARD_MAILBOXES } from '../core';
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
            throw new Error(`Invalid mailbox name: ${mailbox}`);
        }
        return `${this.basePath}/.${mailbox.replace('/', '.')}`;
    }
}
