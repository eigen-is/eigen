import type {Attachment, Email, EmailDraft, EmailSummary, MaildirMailbox} from "@workspace/lib/types/mail"
import {createUniqueMessageId, getMailIDfromFileName} from "./mailutils"
import {createEmlContent} from "./mailfile"
import {parseEml} from "./mail-parse"
import {welcomeMail} from "./welcome"
import MailDB from "./maildb"
import {MaildirStore} from "./maildir-store"
import type {Home} from "../home"
import {draftToMailOptions, sendMail} from './sender'
import {type SSEventMailData, SSEventType} from "@workspace/lib/types/sse"
import {buildMailEvent} from './sse-events'
import {ApiError, PATHS} from '../core'

export default class Maildir {
    private store: MaildirStore
    private db!: MailDB

    constructor(private home: Home) {
        this.store = new MaildirStore(home.homeDir)
    }

    private emit(type: Parameters<typeof buildMailEvent>[0], mail: SSEventMailData, options?: Parameters<typeof buildMailEvent>[2]): void {
        this.home.notify(buildMailEvent(type, mail, options))
    }

    async init() {
        if (!await this.store.exists()) {
            await this.store.createStandardMailboxes()
            await this.mailboxDeliver(welcomeMail(this.home.user.name, this.home.user.email), false)
        }
        this.db = new MailDB(this.home)
        await this.db.init()
    }

    async size(): Promise<number> {
        return (await this.store.dirSize()) || this.db.size()
    }

    // -- Mailbox operations --

    async mailboxesList(): Promise<MaildirMailbox[]> {
        const mailboxNames = await this.store.listMailboxDirs()
        const mailboxes: MaildirMailbox[] = []

        for (const name of mailboxNames) {
            const info = await this.getMailboxInfo(name)
            if (info) mailboxes.push(info)
        }

        return mailboxes
    }

    async mailboxCreate(mailbox: string, attributes: string[] = []): Promise<void> {
        if (await this.store.mailboxDirExists(mailbox)) {
            throw new ApiError(409, `Mailbox '${mailbox}' already exists`)
        }
        await this.store.createMailboxDir(mailbox)
        if (attributes.length > 0) {
            const attributesPath = this.store.storage.pathJoin(this.store.mailboxDir(mailbox), PATHS.MAIL.ATTRIBUTES_FILE)
            await this.store.storage.file(attributesPath).write(JSON.stringify(attributes))
        }
    }

    async mailboxExists(mailbox: string): Promise<MaildirMailbox | false> {
        return await this.getMailboxInfo(mailbox) || false
    }

    async mailboxDeliver(message: string, notify = true): Promise<string> {
        const messageId = createUniqueMessageId()
        const filename = `${messageId}.eml`

        await this.store.deliver(message, '', filename)

        this.syncAndNotify(messageId, notify)

        return filename
    }

    async mailboxGet(mailbox: string): Promise<EmailSummary[]> {
        if (!await this.store.mailboxDirExists(mailbox)) {
            throw new ApiError(404, `Mailbox '${mailbox}' not found`)
        }

        await this.store.moveNewToCur(mailbox)

        const dbMessages = await this.db.getAllEmails(mailbox)
        const dbById = new Map(dbMessages.map(m => [m.id, m]))
        const messages: EmailSummary[] = []

        const curFiles = await this.store.listCurFiles(mailbox)
        for (const fileName of curFiles) {
            const id = getMailIDfromFileName(fileName)
            const cached = dbById.get(id)
            if (cached) {
                messages.push(cached)
            } else {
                const parsed = await this.readAndParse(id, mailbox)
                if (parsed) {
                    messages.push(parsed)
                    this.db.addEmail(parsed)
                }
            }
        }

        return messages
    }

    // -- Message operations --

    async messageGet(messageId: string): Promise<Email | null> {
        try {
            const cached = this.db.getEmail(messageId)
            if (!cached) return null

            const parsed = await this.readAndParse(messageId, cached.mailbox)
            if (!parsed) return null

            for (const a of parsed.attachments) {
                a.content = new Buffer(0)
            }

            return {...parsed, ...cached} as Email
        } catch {
            return null
        }
    }

    async messageGetFile(messageId: string): Promise<ArrayBuffer> {
        const email = this.db.getEmail(messageId)
        if (!email) throw new ApiError(404, `Email '${messageId}' not found`)
        return this.store.readMessageBuffer(email.mailbox, `${messageId}.eml`)
    }

    async messageGetAttachment(messageId: string, index: number): Promise<Attachment | null> {
        const email = this.db.getEmail(messageId)
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`)

        const parsed = await this.readAndParse(messageId, email.mailbox)
        if (!parsed?.attachments || index >= parsed.attachments.length) {
            throw new ApiError(404, `Attachment ${index} not found for message '${messageId}'`)
        }

        return parsed.attachments[index]
    }

    async messageDelete(messageId: string): Promise<void> {
        const email = this.db.getEmail(messageId)
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`)

        this.db.deleteEmail(messageId)
        await this.store.deleteMessage(email.mailbox, `${messageId}.eml`)

        this.emit(SSEventType.MAIL_DELETED, {
            messageId,
            mailbox: email.mailbox || 'inbox',
            subject: email.subject,
        })
    }

    async messageMove(messageId: string, targetMailbox: string): Promise<void> {
        const email = this.db.getEmail(messageId)
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`)

        if (!await this.store.mailboxDirExists(targetMailbox)) {
            throw new ApiError(404, `Target mailbox '${targetMailbox}' not found`)
        }

        const filename = `${messageId}.eml`
        if (!await this.store.fileExistsInCur(email.mailbox, filename)) {
            throw new ApiError(404, `File for message '${messageId}' not found`)
        }

        const sourceMailbox = email.mailbox || 'inbox'
        this.db.moveEmail(messageId, targetMailbox)
        await this.store.moveMessage(email.mailbox, filename, targetMailbox, filename)

        this.emit(SSEventType.MAIL_MOVED, {
            messageId,
            mailbox: sourceMailbox,
            toMailbox: targetMailbox,
            subject: email.subject,
        })
    }

    async messageCopy(messageId: string, targetMailbox: string): Promise<void> {
        const email = this.db.getEmail(messageId)
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`)

        if (!await this.store.mailboxDirExists(targetMailbox)) {
            throw new ApiError(404, `Target mailbox '${targetMailbox}' not found`)
        }

        const filename = `${messageId}.eml`
        if (!await this.store.fileExistsInCur(email.mailbox, filename)) {
            throw new ApiError(404, `File for message '${messageId}' not found`)
        }

        await this.store.copyMessage(email.mailbox, filename, targetMailbox, filename)
    }

    async messageSetRead(messageId: string, read: boolean): Promise<void> {
        const email = this.db.getEmail(messageId)
        if (!email) throw new ApiError(404, `Message '${messageId}' not found`)

        this.db.setRead(messageId, read)
        this.emit(SSEventType.MAIL_READ_CHANGED, {
            messageId,
            mailbox: email.mailbox || 'inbox',
        })
    }

    // -- Draft & Send --

    async messageHandleDraft(email: EmailDraft): Promise<EmailDraft> {
        let draftsMailbox = await this.mailboxExists('Drafts')
        if (!draftsMailbox) {
            await this.mailboxCreate('Drafts', ['\\HasNoChildren', '\\Drafts'])
            draftsMailbox = await this.mailboxExists('Drafts') as MaildirMailbox
        }

        const isNew = (email.id || '').trim() === ''
        const messageId = isNew ? createUniqueMessageId() : email.id
        const filename = `${messageId}.eml`
        const user = this.home.user

        email.from = {
            value: [{address: user.email, name: user.name}],
            html: user.email,
            text: user.email,
        }

        const emlContent = createEmlContent({
            id: messageId,
            subject: email.subject || '',
            from: email.from,
            to: email.to,
            cc: email.cc,
            bcc: email.bcc,
            text: email.text || '',
            html: email.html || '',
            date: new Date(),
        })

        await this.store.writeToMailboxCur('Drafts', filename, emlContent)

        const parsed = await this.readAndParse(messageId, draftsMailbox.name)
        if (!parsed) throw new Error(`Failed to parse draft message: ${messageId}`)

        parsed.isDraft = true
        parsed.mailbox = draftsMailbox.name
        this.db.addEmail(parsed as EmailSummary)

        this.emit(SSEventType.MAIL_DRAFT_UPDATED, {
            messageId,
            mailbox: 'drafts',
            subject: parsed.subject,
        })

        return parsed as EmailDraft
    }

    async messageSend(mailToSend: EmailDraft): Promise<EmailDraft | null> {
        const mail = await this.messageHandleDraft(mailToSend)
        try {
            const mailOptions = draftToMailOptions(mail, this.home.user.email)
            const isDev = Bun.env['PRODUCTION'] !== '1'

            let sent: boolean
            if (isDev) {
                console.log('[DEV MODE] Would send email:', {
                    from: mailOptions.from,
                    to: mailOptions.to,
                    subject: mailOptions.subject,
                    text: mailOptions.text?.substring(0, 200) + '...'
                })
                sent = true
            } else {
                sent = await sendMail(mailOptions)
            }

            if (sent) {
                await this.messageMove(mail.id, 'sent')
                this.emit(SSEventType.MAIL_SENT, {
                    messageId: mail.id,
                    mailbox: 'sent',
                    subject: mail.subject,
                })
            }
        } catch (error) {
            console.error('Error sending email:', error)
            return null
        }
        return mail
    }

    // -- Private helpers --

    private async readAndParse(messageId: string, mailbox: string): Promise<Email | null> {
        try {
            const {content, size} = await this.store.readMessage(mailbox, `${messageId}.eml`)
            return parseEml(messageId, mailbox, content, size)
        } catch {
            return null
        }
    }

    private syncAndNotify(messageId: string, notify: boolean) {
        this.mailboxGet('').then(() => {
            if (!notify) return
            this.messageGet(messageId).then(parsed => {
                if (parsed) {
                    this.emit(SSEventType.MAIL_RECEIVED, {
                        messageId: parsed.id,
                        mailbox: 'inbox',
                        subject: parsed.subject,
                        fromShort: parsed.fromShort,
                    }, {link: `/mail/box/inbox?mailId=${parsed.id}`, tag: 'mail'})
                }
            })
        })
    }

    private async getMailboxInfo(mailboxName: string): Promise<MaildirMailbox | null> {
        if (!await this.store.mailboxDirExists(mailboxName)) return null

        const attributes = await this.store.getMailboxAttributes(mailboxName)
        if (!mailboxName && !attributes.includes('\\Inbox')) {
            attributes.push('\\Inbox')
        }

        return {
            path: mailboxName,
            name: mailboxName ? mailboxName.split('.').pop() || mailboxName : 'INBOX',
            delimiter: '.',
            flags: attributes,
            total: this.db.getEmailsCount(mailboxName),
            unread: this.db.getEmailsCountUnread(mailboxName),
        }
    }

    async destruct(): Promise<void> {
        if (this.db) {
            await this.db.destruct()
        }
    }
}
