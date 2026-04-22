import type { AttachmentReference } from '@workspace/lib/types/chat';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import type { AddressObject } from '@workspace/lib/types/mail';
import MailComposer from 'nodemailer/lib/mail-composer';

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
    attachments?: EmlAttachment[];
};

function formatAddresses(field: AddressObject | undefined): string {
    if (!field?.value || !Array.isArray(field.value)) return '';
    return field.value
        .map((addr) => {
            if (addr.name && addr.address) return `${addr.name.trim()} <${addr.address.trim()}>`;
            return addr.address || addr.name || '';
        })
        .join(', ');
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
        messageId: `<${input.id}@eigen.local>`,
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

export function renderReferenceLinksHtml(references: AttachmentReference[], baseUrl: string): string {
    if (references.length === 0) return '';
    const cards = references
        .map((ref) => {
            const name = stripEigenExtension(ref.name).replace(/[<>&"]/g, '');
            const href = `${baseUrl}/${ref.ownerId}/${ref.mountId}/${ref.id}`;
            return (
                '<div style="display:inline-block;border:1px solid #e0e0e0;border-radius:6px;padding:6px 10px;margin:4px 4px 4px 0;font-size:13px;font-family:sans-serif;color:#333;text-decoration:none;">' +
                `<a href="${href}" style="color:#333;text-decoration:none;">&#128206; ${name}</a>` +
                '</div>'
            );
        })
        .join('');
    return `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #eee;">${cards}</div>`;
}
