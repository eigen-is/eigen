import type { EmailDraft } from '@workspace/lib/types/mail';
import type { OutboundAttachment, OutboundMail } from '../core/mailer';
import { buildMessageId } from './mailutils';
import { canonicalizeRecipients } from './recipients';

// `from` is the draft's own address, else the account's — never absent, so callers can read it directly.
type OutboundMailWithFrom = OutboundMail & { from: NonNullable<OutboundMail['from']> };

export function draftToOutboundMail(draft: EmailDraft, fallbackEmail: string): OutboundMailWithFrom {
    const fromValue = draft.from?.value?.[0];

    // Flatten groups, dedupe and validate once, then split back into the three fields.
    const to: { name: string; address: string }[] = [];
    const cc: { name: string; address: string }[] = [];
    const bcc: { name: string; address: string }[] = [];
    const byField = { to, cc, bcc };
    for (const { name, address, field } of canonicalizeRecipients(draft)) {
        byField[field].push({ name, address });
    }

    const message: OutboundMailWithFrom = {
        from: fromValue?.address
            ? { name: fromValue.name || '', address: fromValue.address }
            : { name: '', address: fallbackEmail },
        to,
        subject: draft.subject || '',
        text: draft.text || '',
        // Pin the wire Message-ID to the value the Sent EML carries (mailfile.ts), so a reply to
        // our sent mail threads against a header the recipient actually saw.
        messageId: buildMessageId(draft.id),
    };

    if (cc.length) message.cc = cc;
    if (bcc.length) message.bcc = bcc;
    if (draft.inReplyTo) message.inReplyTo = draft.inReplyTo;
    if (draft.references) message.references = draft.references;

    if (draft.html) message.html = draft.html;

    if (draft.attachments?.length) {
        message.attachments = draft.attachments.flatMap((a): OutboundAttachment[] =>
            a.filename ? [{ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType }] : [],
        );
    }

    return message;
}
