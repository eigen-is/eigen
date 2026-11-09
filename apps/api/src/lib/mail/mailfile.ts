// Composes a saved draft's `.eml`, the bytes the Maildir keeps and an IMAP client reads. The draft save calls it. The
// file is the draft's only copy, so it holds what never goes out too: the Bcc and the message the draft answers.

import { flattenAddresses } from '@workspace/lib/mail/addresses';
import type { AddressObject } from '@workspace/lib/types/mail';
import MailComposer from 'nodemailer/lib/mail-composer';
import { REPLIED_TO_HEADER } from './mail-parser';
import { buildMessageId } from './mailutils';

export type EmlAttachment = {
    filename: string;
    content: Buffer;
    contentType?: string;
};

export type EmlInput = {
    id: string;
    from?: AddressObject;
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
    subject: string;
    text: string;
    html: string;
    date?: Date;
    inReplyTo?: string;
    references?: string | string[];
    repliedToId?: string;
    attachments?: EmlAttachment[];
};

function formatAddresses(field: AddressObject | undefined): string {
    if (!field?.value) return '';
    // The send path only ever sees the re-parsed header, so a bare group name here would drop every member.
    return flattenAddresses(field.value)
        .map(({ name, address }) => (name ? `${name.trim()} <${address.trim()}>` : address.trim()))
        .join(', ');
}

export async function createEmlContent(input: EmlInput): Promise<Buffer> {
    const composer = new MailComposer({
        from: formatAddresses(input.from),
        to: formatAddresses(input.to),
        cc: formatAddresses(input.cc),
        bcc: formatAddresses(input.bcc),
        subject: input.subject,
        text: input.text,
        html: input.html,
        date: input.date ?? new Date(),
        messageId: buildMessageId(input.id),
        inReplyTo: input.inReplyTo,
        references: input.references,
        headers: input.repliedToId ? { [REPLIED_TO_HEADER]: input.repliedToId } : undefined,
        attachments: input.attachments?.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
        })),
    });

    const node = composer.compile();
    // Set on this node alone: an outgoing message is built by the mailer from its fields, so its Bcc stays off the wire.
    node.keepBcc = true;
    return new Promise<Buffer>((resolve, reject) => {
        node.build((err, message) => {
            if (err) reject(err);
            else resolve(message);
        });
    });
}
