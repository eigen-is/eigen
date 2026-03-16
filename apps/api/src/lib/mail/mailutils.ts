import {v4 as uuidv4} from "uuid"

const STANDARD_MAILBOX_FLAGS: Record<string, string[]> = {
    '': ['\\HasNoChildren', '\\Inbox'],
    'inbox': ['\\HasNoChildren', '\\Inbox'],
    'sent': ['\\HasNoChildren', '\\Sent'],
    'drafts': ['\\HasNoChildren', '\\Drafts'],
    'trash': ['\\HasNoChildren', '\\Trash'],
    'junk': ['\\HasNoChildren', '\\Junk'],
    'spam': ['\\HasNoChildren', '\\Junk'],
    'archive': ['\\HasNoChildren', '\\Archive'],
}

export function getMailIDfromFileName(fileName: string): string {
    let fileId = fileName.split(':')[0]
    if (fileId.endsWith('.eml')) {
        fileId = fileId.substring(0, fileId.length - 4)
    }
    return fileId
}

export function createUniqueMessageId(): string {
    return `${Date.now()}.${uuidv4()}`
}

export function getStandardMailboxFlags(mailboxName: string): string[] {
    const flags = STANDARD_MAILBOX_FLAGS[mailboxName.toLowerCase()]
    return flags ? [...flags] : ['\\HasNoChildren']
}
