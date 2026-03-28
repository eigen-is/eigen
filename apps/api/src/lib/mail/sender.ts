import type { EmailDraft } from '@workspace/lib/types/mail';
import type { OutboundAttachment, OutboundMail } from '../core/mailer';

export function draftToOutboundMail(draft: EmailDraft, fallbackEmail: string): OutboundMail {
    const fromValue = draft.from?.value?.[0];

    const message: OutboundMail = {
        from: fromValue?.address
            ? { name: fromValue.name || '', address: fromValue.address }
            : { name: '', address: fallbackEmail },
        to: convertAddressValue(draft.to?.value),
        subject: draft.subject || '(No subject)',
        text: draft.text || '',
    };

    const cc = convertAddressValue(draft.cc?.value);
    if (cc.length) message.cc = cc;

    const bcc = convertAddressValue(draft.bcc?.value);
    if (bcc.length) message.bcc = bcc;

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

function convertAddressValue(value: { name?: string; address?: string }[] | undefined) {
    if (!value) return [];
    return value.filter((v) => v.address).map((v) => ({ name: v.name || '', address: v.address! }));
}
