import type { AddressObject } from '@workspace/lib/types/mail';
import MailComposer from 'nodemailer/lib/mail-composer';
import { buildMessageId } from './mailutils';
import { flattenAddresses } from './recipients';

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
    attachments?: EmlAttachment[];
};

function formatAddresses(field: AddressObject | undefined): string {
    if (!field?.value || !Array.isArray(field.value)) return '';
    // Flatten groups into their leaf members so group recipients survive the compose → re-parse
    // round-trip: the send path's canonicaliser only ever sees the re-parsed header, so a bare
    // group name here would drop every member. One source of truth — shared with the send path.
    const flat: { name: string; address: string }[] = [];
    flattenAddresses(field.value, flat);
    return flat.map(({ name, address }) => (name ? `${name.trim()} <${address.trim()}>` : address.trim())).join(', ');
}

export async function createEmlContent(input: EmlInput): Promise<string> {
    const composer = new MailComposer({
        from: formatAddresses(input.from),
        to: formatAddresses(input.to),
        cc: formatAddresses(input.cc),
        bcc: formatAddresses(input.bcc),
        subject: input.subject || '',
        text: input.text || '',
        html: input.html || '',
        date: input.date ?? new Date(),
        messageId: buildMessageId(input.id),
        inReplyTo: input.inReplyTo,
        references: input.references,
        attachments: input.attachments?.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
        })),
    });

    const buffer = await new Promise<Buffer>((resolve, reject) => {
        composer.compile().build((err, message) => {
            if (err) reject(err);
            else resolve(message);
        });
    });

    return buffer.toString('utf-8');
}
