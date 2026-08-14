import { hostname } from 'node:os';
import type { AddressObject, EmailSummary } from '@workspace/lib/types/mail';
import { getMailDomain } from '../config/server-config';
import type { MailFlag } from './mail-store';

let deliveryCounter = 0;

const STANDARD_MAILBOX_FLAGS: Record<string, string[]> = {
    '': ['\\HasNoChildren', '\\Inbox'],
    Sent: ['\\HasNoChildren', '\\Sent'],
    Drafts: ['\\HasNoChildren', '\\Drafts'],
    Trash: ['\\HasNoChildren', '\\Trash'],
    Junk: ['\\HasNoChildren', '\\Junk'],
    Archive: ['\\HasNoChildren', '\\Archive'],
};

const FLAG_MAP: Record<MailFlag, string> = {
    seen: 'S',
    replied: 'R',
    flagged: 'F',
    draft: 'D',
    trashed: 'T',
    forwarded: 'P',
};

export function createUniqueMessageId(): string {
    const time = Math.floor(Date.now() / 1000);
    const usec = (Date.now() % 1000) * 1000;
    const pid = process.pid;
    const seq = deliveryCounter++;
    const host = hostname().replace(/\//g, '\\057').replace(/:/g, '\\072');
    return `${time}.M${usec}P${pid}Q${seq}.${host}`;
}

export function buildMessageId(id: string): string {
    return `<${id}@${getMailDomain()}>`;
}

export function getMailIDfromFileName(fileName: string): string {
    const colonIndex = fileName.indexOf(':');
    const withoutFlags = colonIndex >= 0 ? fileName.substring(0, colonIndex) : fileName;
    const commaIndex = withoutFlags.indexOf(',');
    return commaIndex >= 0 ? withoutFlags.substring(0, commaIndex) : withoutFlags;
}

export function getStandardMailboxFlags(mailbox: string): string[] {
    const flags = STANDARD_MAILBOX_FLAGS[mailbox];
    return flags ? [...flags] : ['\\HasNoChildren'];
}

export function buildMaildirFilename(uniqueId: string, flags: Record<string, boolean>, size?: number): string {
    const sizeHint = size != null ? `,S=${size}` : '';
    const flagStr = Object.entries(FLAG_MAP)
        .filter(([key]) => flags[key])
        .map(([, char]) => char)
        .sort()
        .join('');
    return `${uniqueId}${sizeHint}:2,${flagStr}`;
}

export function parseFlagsFromFilename(fileName: string) {
    const match = fileName.match(/:2,([A-Za-z]*)/);
    const flagStr = match?.[1] || '';
    return {
        seen: flagStr.includes('S'),
        replied: flagStr.includes('R'),
        flagged: flagStr.includes('F'),
        draft: flagStr.includes('D'),
        trashed: flagStr.includes('T'),
        forwarded: flagStr.includes('P'),
    };
}

export function rebuildFlagsSuffix(currentFilename: string, changes: Partial<Record<MailFlag, boolean>>): string {
    const match = currentFilename.match(/:2,([A-Za-z]*)/);
    const existing = match?.[1] || '';
    const keywords = existing.replace(/[A-Z]/g, '');
    const current = parseFlagsFromFilename(currentFilename);
    const merged = { ...current, ...changes };
    const standardFlags = Object.entries(FLAG_MAP)
        .filter(([key]) => merged[key as MailFlag])
        .map(([, char]) => char)
        .sort()
        .join('');
    return standardFlags + keywords;
}

export function applyFlagsFromFilename(email: EmailSummary, filename: string): void {
    const flags = parseFlagsFromFilename(filename);
    email.isRead = flags.seen;
    email.isFlagged = flags.flagged;
    email.isDraft = flags.draft;
    email.isReplied = flags.replied;
}

export function buildRecipientSummary(
    to: AddressObject | AddressObject[] | undefined,
    cc: AddressObject | AddressObject[] | undefined,
): { toShort: string; toAddress: string; recipientsAll: string } {
    const toList = to ? (Array.isArray(to) ? to : [to]) : [];
    const ccList = cc ? (Array.isArray(cc) ? cc : [cc]) : [];
    const firstTo = toList[0]?.value[0];
    const allRecipients = [...toList, ...ccList].flatMap((o) => o.value);
    return {
        toShort: firstTo?.name || firstTo?.address || '',
        toAddress: firstTo?.address || '',
        recipientsAll: allRecipients
            .map((a) => `${a.name || ''} ${a.address || ''}`.trim())
            .filter((s) => s.length > 0)
            .join('\n'),
    };
}
