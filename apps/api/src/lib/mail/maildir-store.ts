import {LocalFilesystem, PATHS, STANDARD_MAILBOXES} from '../core'
import {getStandardMailboxFlags} from './mailutils'

const {ROOT, MAILDIR, CUR, NEW, TMP, ATTRIBUTES_FILE} = PATHS.MAIL

export class MaildirStore {
    readonly basePath = MAILDIR
    readonly storage: LocalFilesystem

    constructor(homeDir: string) {
        this.storage = new LocalFilesystem(`${homeDir}/${ROOT}`)
    }

    async exists(): Promise<boolean> {
        return this.storage.dirExists(this.basePath)
    }

    async createStandardMailboxes(): Promise<void> {
        for (const mailbox of STANDARD_MAILBOXES) {
            const mailboxPath = this.mailboxDir(mailbox)
            if (await this.storage.dirExists(mailboxPath)) continue

            await this.storage.mkdir(mailboxPath)
            await this.storage.mkdir(this.storage.pathJoin(mailboxPath, CUR))
            await this.storage.mkdir(this.storage.pathJoin(mailboxPath, NEW))
            await this.storage.mkdir(this.storage.pathJoin(mailboxPath, TMP))

            const attributesPath = this.storage.pathJoin(mailboxPath, ATTRIBUTES_FILE)
            const attributes = getStandardMailboxFlags(mailbox)
            await this.storage.file(attributesPath).write(JSON.stringify(attributes))
        }
    }

    async mailboxDirExists(mailbox: string): Promise<boolean> {
        return this.storage.dirExists(this.mailboxDir(mailbox))
    }

    async listMailboxDirs(): Promise<string[]> {
        const entries = await this.storage.readdir(this.basePath, {withFileTypes: true})
        const mailboxes: string[] = ['']
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith('.') && ![CUR, NEW, TMP].includes(entry.name)) {
                mailboxes.push(entry.name.substring(1))
            }
        }
        return mailboxes
    }

    async getMailboxAttributes(mailbox: string): Promise<string[]> {
        const attributesPath = this.storage.pathJoin(this.mailboxDir(mailbox), ATTRIBUTES_FILE)
        if (await this.storage.fileExists(attributesPath)) {
            return this.storage.file(attributesPath).json()
        }
        const name = this.storage.pathBasename(mailbox)
        return getStandardMailboxFlags(name)
    }

    async createMailboxDir(mailbox: string): Promise<void> {
        const mailboxPath = this.mailboxDir(mailbox)
        await this.storage.mkdir(mailboxPath)
        await this.storage.mkdir(this.storage.pathJoin(mailboxPath, CUR))
        await this.storage.mkdir(this.storage.pathJoin(mailboxPath, NEW))
        await this.storage.mkdir(this.storage.pathJoin(mailboxPath, TMP))
    }

    async deliver(message: string, mailbox: string, filename: string): Promise<void> {
        const mailboxPath = this.mailboxDir(mailbox)
        const filePath = this.storage.pathJoin(mailboxPath, NEW, filename)
        await this.storage.file(filePath).write(message)
    }

    async moveNewToCur(mailbox: string): Promise<void> {
        const mailboxPath = this.mailboxDir(mailbox)
        const newPath = this.storage.pathJoin(mailboxPath, NEW)
        const curPath = this.storage.pathJoin(mailboxPath, CUR)
        if (!await this.storage.dirExists(newPath)) return

        const files = await this.storage.readdir(newPath)
        for (const fileName of files) {
            const srcPath = this.storage.pathJoin(newPath, fileName)
            if (await this.storage.fileExists(srcPath)) {
                await this.storage.rename(srcPath, this.storage.pathJoin(curPath, fileName))
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

    async moveMessage(fromMailbox: string, fromFilename: string, toMailbox: string, toFilename: string): Promise<void> {
        const srcPath = this.storage.pathJoin(this.mailboxDir(fromMailbox), CUR, fromFilename)
        const dstPath = this.storage.pathJoin(this.mailboxDir(toMailbox), CUR, toFilename)
        await this.storage.rename(srcPath, dstPath)
    }

    async copyMessage(fromMailbox: string, fromFilename: string, toMailbox: string, toFilename: string): Promise<void> {
        const srcPath = this.storage.pathJoin(this.mailboxDir(fromMailbox), CUR, fromFilename)
        const dstPath = this.storage.pathJoin(this.mailboxDir(toMailbox), CUR, toFilename)
        const content = await this.storage.file(srcPath).text()
        await this.storage.file(dstPath).write(content)
    }

    async deleteMessage(mailbox: string, filename: string): Promise<void> {
        const filePath = this.storage.pathJoin(this.mailboxDir(mailbox), CUR, filename)
        if (await this.storage.fileExists(filePath)) {
            await this.storage.unlink(filePath)
        }
    }

    async writeToMailboxCur(mailbox: string, filename: string, content: string): Promise<void> {
        const filePath = this.storage.pathJoin(this.mailboxDir(mailbox), CUR, filename)
        await this.storage.file(filePath).write(content)
    }

    async fileExistsInCur(mailbox: string, filename: string): Promise<boolean> {
        const filePath = this.storage.pathJoin(this.mailboxDir(mailbox), CUR, filename)
        return this.storage.fileExists(filePath)
    }

    async dirSize(): Promise<number> {
        return (await this.storage.dirSize(ROOT)) || 0
    }

    mailboxDir(mailbox: string): string {
        if (mailbox === '' || mailbox.toLowerCase() === 'inbox') {
            return this.basePath
        }
        let dirname = `${this.basePath}/.${mailbox.toLowerCase().replace('/', '.')}`
        dirname = dirname.replace(/\.{2,}/g, '.')
        dirname = dirname.replace(/\/+/g, '/')
        return dirname
    }
}
