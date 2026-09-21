import type { Email, ParsedMail } from '@workspace/lib/types/mail';
import type { BunFile } from 'bun';
import DOMPurify from 'isomorphic-dompurify';
import { parseMail } from './mail-parser';
import { buildRecipientSummary } from './mailutils';

// The rule for every surface that renders a message, stated once (the .eml preview forbids more on top of
// it): `target` keeps an attachment pill out of the mail view, and a <form> DOMPurify would keep by default
// can post the reader's input anywhere.
export const READER_SANITIZE_CONFIG = { FORCE_BODY: true, ADD_ATTR: ['target'], FORBID_TAGS: ['form'] };

// Everything but the reader: `html: null` by type, so an unsanitized body cannot be served by mistake.
export type IndexedEmail = Email & { html: null };

// Throws on a genuine parse/read fault (unreadable .eml, disk EIO, malformed MIME). Callers
// decide the policy: single-message reads (messageGet) let it propagate → Elysia 500; bulk
// sweeps (syncMailbox) wrap it in a logged try/catch so one bad message can't abort the batch.
// It must never mask a fault as a missing message.
export async function parseEml(messageId: string, mailbox: string, file: BunFile): Promise<IndexedEmail> {
    return parseEmlBytes(messageId, mailbox, Buffer.from(await file.arrayBuffer()), file.size);
}

// Same parse over in-memory bytes — lets the draft hot path skip the disk read-back (the bytes it
// writes are exactly what parseEml would read back). `size` is the byte length of those bytes.
export async function parseEmlBytes(
    messageId: string,
    mailbox: string,
    bytes: Buffer,
    size: number,
): Promise<IndexedEmail> {
    return { ...toEmail(messageId, mailbox, parseMail(bytes), size), html: null };
}

// The one entry that hands out a body, sanitized: every surface that renders a message reads its result.
export async function parseEmlForReader(messageId: string, mailbox: string, file: BunFile): Promise<Email> {
    const parsedMail = parseMail(Buffer.from(await file.arrayBuffer()));
    if (parsedMail.html) {
        parsedMail.html = DOMPurify.sanitize(parsedMail.html, READER_SANITIZE_CONFIG).replace(/\s+/g, ' ').trim();
    }
    return toEmail(messageId, mailbox, parsedMail, file.size);
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
