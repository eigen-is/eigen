// Turns a message's `.eml` bytes into the Email the mail store hands out. The index and the sync take the body-less
// parse, and only the reader's parse hands out a body: sanitized, and for a draft with its references read back out.
// A second, stricter sanitize is the `.eml` preview's own.

import type { Email, ParsedMail } from '@workspace/lib/types/mail';
import type { BunFile } from 'bun';
import DOMPurify from 'isomorphic-dompurify';
import { parseMail } from './mail-parser';
import { buildRecipientSummary } from './mailutils';
import { cutDraftReferences } from './reference-links';

// The rule for every surface that renders a message: `target` keeps an attachment pill out of the mail view, and a
// <form> DOMPurify would keep by default can post the reader's input anywhere.
export const READER_SANITIZE_CONFIG = { FORCE_BODY: true, ADD_ATTR: ['target'], FORBID_TAGS: ['form'] };

// Everything but the reader: `html: null` by type, so an unsanitized body cannot be served by mistake.
export type IndexedEmail = Email & { html: null };

// Throws on a genuine read or parse fault, and each caller decides the policy: a single read lets it reach a 500, and a
// sync logs it, so one bad message can't abort the batch. It never masks a fault as a missing message.
export async function parseEml(messageId: string, mailbox: string, file: BunFile): Promise<IndexedEmail> {
    return parseEmlBytes(messageId, mailbox, Buffer.from(await file.arrayBuffer()));
}

// Lets a draft save skip the disk read-back of the bytes it just wrote.
export function parseEmlBytes(messageId: string, mailbox: string, bytes: Buffer): IndexedEmail {
    return { ...toEmail(messageId, mailbox, parseMail(bytes), bytes.length), html: null };
}

// The one entry that hands out a body, sanitized: every surface that renders a message reads its result. A draft's
// references come out first, because the sanitize drops the comment they sit in.
export async function parseEmlForReader(
    messageId: string,
    mailbox: string,
    file: BunFile,
    isDraft: boolean,
): Promise<Email> {
    const parsedMail = parseMail(Buffer.from(await file.arrayBuffer()));
    const draft = isDraft ? cutDraftReferences(parsedMail.html ?? '') : undefined;
    if (draft) parsedMail.html = draft.html;
    if (parsedMail.html) {
        parsedMail.html = DOMPurify.sanitize(parsedMail.html, READER_SANITIZE_CONFIG).replace(/\s+/g, ' ').trim();
    }
    return { ...toEmail(messageId, mailbox, parsedMail, file.size), driveReferences: draft?.driveReferences };
}

function toEmail(messageId: string, mailbox: string, parsedMail: ParsedMail, size: number): Email {
    const { toShort, toAddress, recipientsAll } = buildRecipientSummary(parsedMail.to, parsedMail.cc);

    return {
        ...parsedMail,
        subject: parsedMail.subject ?? '',
        date: parsedMail.date ?? new Date(),
        id: messageId,
        filename: '',
        mailbox,
        size,
        isRead: false,
        isFlagged: false,
        isDraft: false,
        isReplied: false,
        hasAttachments: parsedMail.attachments.length > 0,
        fromShort: parsedMail.from?.value[0]?.name || parsedMail.from?.value[0]?.address || 'Unknown',
        fromAddress: parsedMail.from?.value[0]?.address || '',
        toShort,
        toAddress,
        recipientsAll,
        textShort: parsedMail.text || '',
    };
}
