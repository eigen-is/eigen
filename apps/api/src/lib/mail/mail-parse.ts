import type { Email } from '@workspace/lib/types/mail';
import type { BunFile } from 'bun';
import DOMPurify from 'isomorphic-dompurify';
import { parseMail } from './mail-parser';
import { buildRecipientSummary } from './mailutils';

// Throws on a genuine parse/read fault (unreadable .eml, disk EIO, malformed MIME). Callers
// decide the policy: single-message reads (messageGet) let it propagate → Elysia 500; bulk
// sweeps (syncMailbox) wrap it in a logged try/catch so one bad message can't abort the batch.
// It must never mask a fault as a missing message.
export async function parseEml(messageId: string, mailbox: string, file: BunFile): Promise<Email> {
    return parseEmlBytes(messageId, mailbox, Buffer.from(await file.arrayBuffer()), file.size);
}

// Same parse over in-memory bytes — lets the draft hot path skip the disk read-back (the bytes it
// writes are exactly what parseEml would read back). `size` is the byte length of those bytes.
export async function parseEmlBytes(messageId: string, mailbox: string, bytes: Buffer, size: number): Promise<Email> {
    const parsedMail = parseMail(bytes);

    if (parsedMail.html) {
        // ADD_ATTR keeps `target` on anchors so eigen-doc attachment pills (and any other
        // sender-set target=_blank link) open in a new tab instead of replacing the mail view.
        parsedMail.html = DOMPurify.sanitize(parsedMail.html, { FORCE_BODY: true, ADD_ATTR: ['target'] });
        parsedMail.html = parsedMail.html.replace(/\s+/g, ' ').trim();
    }

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
        hasAttachments: parsedMail.attachments?.length > 0,
        fromShort: parsedMail.from?.value[0]?.name || parsedMail.from?.value[0]?.address || 'Unknown',
        fromAddress: parsedMail.from?.value[0]?.address || '',
        toShort,
        toAddress,
        recipientsAll,
        textShort: parsedMail.text || '',
    };
}
