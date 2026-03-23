import type {FSWatcher} from 'node:fs'
import {LocalFilesystem, PATHS, STANDARD_MAILBOXES} from '../core'
import {buildMaildirFilename, createUniqueMessageId} from './mailutils'

const {ROOT, MAILDIR, CUR, NEW, TMP} = PATHS.MAIL

export class MaildirStore {
    readonly basePath = MAILDIR
    readonly storage: LocalFilesystem
    private watchers: FSWatcher[] = []

    constructor(homeDir: string) {
        this.storage = new LocalFilesystem(`${homeDir}/${ROOT}`)
    }

    async exists(): Promise<boolean> {
        return this.storage.dirExists(this.basePath)
    }

    async createStandardMailboxes(): Promise<void> {
        for (const mailbox of STANDARD_MAILBOXES) {
            if (!await this.storage.dirExists(this.mailboxDir(mailbox))) {
                await this.createMailboxDir(mailbox)
            }
        }

        const subscriptions = STANDARD_MAILBOXES.filter(m => m !== '').join('\n') + '\n'
        await this.storage.file(this.storage.pathJoin(this.basePath, 'subscriptions')).write(subscriptions)
    }

    async mailboxDirExists(mailbox: string): Promise<boolean> {
        return this.storage.dirExists(this.mailboxDir(mailbox))
    }

    async createMailboxDir(mailbox: string): Promise<void> {
        const mailboxPath = this.mailboxDir(mailbox)
        await this.storage.mkdir(mailboxPath)
        await this.storage.mkdir(this.storage.pathJoin(mailboxPath, CUR))
        await this.storage.mkdir(this.storage.pathJoin(mailboxPath, NEW))
        await this.storage.mkdir(this.storage.pathJoin(mailboxPath, TMP))
        if (mailbox !== '') {
            await this.storage.file(this.storage.pathJoin(mailboxPath, 'maildirfolder')).write('')
        }
    }

    async deliverAtomic(message: string, mailbox: string): Promise<{uniqueId: string, size: number}> {
        const uniqueId = createUniqueMessageId()
        const size = Buffer.byteLength(message, 'utf-8')
        const filename = `${uniqueId},S=${size}`
        const mailboxPath = this.mailboxDir(mailbox)

        const tmpPath = this.storage.pathJoin(mailboxPath, TMP, filename)
        await this.storage.file(tmpPath).write(message)

        const newPath = this.storage.pathJoin(mailboxPath, NEW, filename)
        await this.storage.rename(tmpPath, newPath)

        return {uniqueId, size}
    }

    async deliverToCur(mailbox: string, message: string, flags: Record<string, boolean>, existingId?: string): Promise<{
        uniqueId: string,
        size: number,
        filename: string
    }> {
        const uniqueId = existingId ?? createUniqueMessageId()
        const size = Buffer.byteLength(message, 'utf-8')
        const filename = buildMaildirFilename(uniqueId, flags, size)
        const mailboxPath = this.mailboxDir(mailbox)

        const tmpPath = this.storage.pathJoin(mailboxPath, TMP, filename)
        await this.storage.file(tmpPath).write(message)

        const curPath = this.storage.pathJoin(mailboxPath, CUR, filename)
        await this.storage.rename(tmpPath, curPath)

        return {uniqueId, size, filename}
    }

    async moveNewToCur(mailbox: string): Promise<void> {
        const mailboxPath = this.mailboxDir(mailbox)
        const newPath = this.storage.pathJoin(mailboxPath, NEW)
        if (!await this.storage.dirExists(newPath)) return

        for (const fileName of await this.storage.readdir(newPath)) {
            if (fileName.startsWith('.')) continue
            const src = this.storage.pathJoin(newPath, fileName)
            const curName = fileName.includes(':') ? fileName : `${fileName}:2,`
            const dst = this.storage.pathJoin(mailboxPath, CUR, curName)
            try {
                await this.storage.rename(src, dst)
            } catch (e: any) {
                if (e.code !== 'ENOENT') throw e
            }
        }
    }

    async listCurFiles(mailbox: string): Promise<string[]> {
        const curPath = this.storage.pathJoin(this.mailboxDir(mailbox), CUR)
        if (!await this.storage.dirExists(curPath)) return []
        return this.storage.readdir(curPath)
    }

    async readMessage(mailbox: string, filename: string): Promise<{content: string, size: number}> {
        const filePath = this.storage.pathJoin(this.mailboxDir(mailbox), CUR, filename)
        const file = this.storage.file(filePath)
        return {content: await file.text(), size: file.size}
    }

    async readMessageBuffer(mailbox: string, filename: string): Promise<ArrayBuffer> {
        const filePath = this.storage.pathJoin(this.mailboxDir(mailbox), CUR, filename)
        return this.storage.file(filePath).arrayBuffer()
    }

    async moveMessage(fromMailbox: string, fromFilename: string, toMailbox: string): Promise<void> {
        const srcPath = this.storage.pathJoin(this.mailboxDir(fromMailbox), CUR, fromFilename)
        const dstPath = this.storage.pathJoin(this.mailboxDir(toMailbox), CUR, fromFilename)
        await this.storage.rename(srcPath, dstPath)
    }

    async renameInCur(mailbox: string, oldFilename: string, newFilename: string): Promise<void> {
        const curPath = this.storage.pathJoin(this.mailboxDir(mailbox), CUR)
        await this.storage.rename(
            this.storage.pathJoin(curPath, oldFilename),
            this.storage.pathJoin(curPath, newFilename),
        )
    }

    async deleteMessage(mailbox: string, filename: string): Promise<void> {
        const filePath = this.storage.pathJoin(this.mailboxDir(mailbox), CUR, filename)
        if (await this.storage.fileExists(filePath)) {
            await this.storage.unlink(filePath)
        }
    }

    async findFileByUniqueId(uniqueId: string, mailbox: string): Promise<string | undefined> {
        const files = await this.listCurFiles(mailbox)
        return files.find(f => f.startsWith(uniqueId))
    }

    async dirSize(): Promise<number> {
        return (await this.storage.dirSize(ROOT)) || 0
    }

    watchMailboxes(onChange: (mailbox: string) => void): void {
        for (const mailbox of STANDARD_MAILBOXES) {
            const mailboxPath = this.mailboxDir(mailbox)
            for (const subdir of [CUR, NEW]) {
                try {
                    const watcher = this.storage.watch(
                        this.storage.pathJoin(mailboxPath, subdir),
                        () => onChange(mailbox),
                    )
                    this.watchers.push(watcher)
                } catch {
                    // Directory may not exist yet
                }
            }
        }
    }

    unwatchMailboxes(): void {
        for (const watcher of this.watchers) watcher.close()
        this.watchers = []
    }

    mailboxDir(mailbox: string): string {
        if (mailbox === '' || mailbox === 'INBOX') return this.basePath
        if (/[^a-zA-Z0-9._\- /]/.test(mailbox) || mailbox.includes('..')) {
            throw new Error(`Invalid mailbox name: ${mailbox}`)
        }
        return `${this.basePath}/.${mailbox.replace('/', '.')}`
    }
}
