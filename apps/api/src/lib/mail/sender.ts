import type { EmailDraft } from '@workspace/lib/types/mail';
import type { OutboundAttachment, OutboundMail } from '../core/mailer';
import { buildMessageId } from './mailutils';
import { canonicalizeRecipients } from './recipients';

export function draftToOutboundMail(draft: EmailDraft, fallbackEmail: string): OutboundMail {
    const fromValue = draft.from?.value?.[0];

    // Flatten groups, dedupe and validate once, then split back into the three fields.
    const to: { name: string; address: string }[] = [];
    const cc: { name: string; address: string }[] = [];
    const bcc: { name: string; address: string }[] = [];
    const byField = { to, cc, bcc };
    for (const { name, address, field } of canonicalizeRecipients(draft)) {
        byField[field].push({ name, address });
    }

    const message: OutboundMail = {
        from: fromValue?.address
            ? { name: fromValue.name || '', address: fromValue.address }
            : { name: '', address: fallbackEmail },
        to,
        subject: draft.subject || '(No subject)',
        text: draft.text || '',
        // Pin the wire Message-ID to the value the Sent EML carries (mailfile.ts), so a reply to
        // our sent mail threads against a header the recipient actually saw.
        messageId: buildMessageId(draft.id),
    };

    if (cc.length) message.cc = cc;
    if (bcc.length) message.bcc = bcc;
    if (draft.inReplyTo) message.inReplyTo = draft.inReplyTo;
    if (draft.references) message.references = draft.references;

    const html = draft.html;
    if (html) message.html = html;

    if (draft.attachments?.length) {
        message.attachments = draft.attachments
            .filter((a) => a.content && a.filename)
            .map(
                (a): OutboundAttachment => ({
                    filename: a.filename!,
                    content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content)),
                    contentType: a.contentType,
                }),
            );
    }

    return message;
}
