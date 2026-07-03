import type { Email } from '@workspace/lib/types/mail';
import type { BunFile } from 'bun';
import DOMPurify from 'isomorphic-dompurify';
import { simpleParser } from './mail-parser';

// Throws on a genuine parse/read fault (unreadable .eml, disk EIO, malformed MIME). Callers
// decide the policy: single-message reads (messageGet) let it propagate → Elysia 500; bulk
// sweeps (syncMailbox) wrap it in a logged try/catch so one bad message can't abort the batch.
// It must never mask a fault as a missing message.
export async function parseEml(messageId: string, mailbox: string, file: BunFile): Promise<Email> {
    const parsedMail = await simpleParser(Buffer.from(await file.arrayBuffer()), {});

    if (parsedMail.html) {
        // ADD_ATTR keeps `target` on anchors so eigen-doc attachment pills (and any other
        // sender-set target=_blank link) open in a new tab instead of replacing the mail view.
        parsedMail.html = DOMPurify.sanitize(parsedMail.html, { FORCE_BODY: true, ADD_ATTR: ['target'] });
        parsedMail.html = parsedMail.html.replace(/\s+/g, ' ').trim();
    }

    const toRecipients = parsedMail.to ? (Array.isArray(parsedMail.to) ? parsedMail.to : [parsedMail.to]) : [];
    const ccRecipients = parsedMail.cc ? (Array.isArray(parsedMail.cc) ? parsedMail.cc : [parsedMail.cc]) : [];
    const firstTo = toRecipients[0]?.value[0];
    const allRecipients = [...toRecipients, ...ccRecipients].flatMap((o) => o.value);
    const recipientsAll = allRecipients
        .map((a) => `${a.name || ''} ${a.address || ''}`.trim())
        .filter((s) => s.length > 0)
        .join('\n');

    return {
        ...parsedMail,
        id: messageId,
        filename: '',
        mailbox,
        size: file.size,
        isRead: false,
        isFlagged: false,
        isDraft: false,
        isReplied: false,
        hasAttachments: parsedMail.attachments?.length > 0,
        fromShort: parsedMail.from?.value[0]?.name || parsedMail.from?.value[0]?.address || 'Unknown',
        fromAddress: parsedMail.from?.value[0]?.address || '',
        toShort: firstTo?.name || firstTo?.address || '',
        toAddress: firstTo?.address || '',
        recipientsAll,
        textShort: parsedMail.text || '',
    } as Email;
}
