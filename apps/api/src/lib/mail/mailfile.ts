import {
    DRIVE_TYPE_CHAT,
    DRIVE_TYPE_DOC,
    DRIVE_TYPE_SHEETS,
    DRIVE_TYPE_SLIDES,
    DRIVE_TYPE_STICKIES,
    isFolderType,
    stripEigenExtension,
} from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { AddressObject } from '@workspace/lib/types/mail';
import MailComposer from 'nodemailer/lib/mail-composer';
import { escapeHtml } from '../core';

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

function appUrl(name: string, fallback: string): string {
    return process.env[name] || fallback;
}

function buildReferenceUrl(ref: AttachmentReference): string | undefined {
    const path = `${ref.ownerId}/${ref.mountId}/${ref.id}`;
    switch (ref.driveType) {
        case DRIVE_TYPE_DOC:
            return `${appUrl('VITE_APP_DOCS_URL', 'http://localhost:3006/docs')}/doc/${path}`;
        case DRIVE_TYPE_STICKIES:
            return `${appUrl('VITE_APP_STICKIES_URL', 'http://localhost:3007/stickies')}/board/${path}`;
        case DRIVE_TYPE_SLIDES:
            return `${appUrl('VITE_APP_SLIDES_URL', 'http://localhost:3012/slides')}/slide/${path}`;
        case DRIVE_TYPE_SHEETS:
            return `${appUrl('VITE_APP_SHEETS_URL', 'http://localhost:3013/sheets')}/sheet/${path}`;
        case DRIVE_TYPE_CHAT:
            return `${appUrl('VITE_APP_CHAT_URL', 'http://localhost:3008/chat')}/${path}`;
    }
    if (isFolderType(ref.driveType)) {
        return `${appUrl('VITE_APP_DRIVE_URL', 'http://localhost:3002/drive')}/fs/${path}`;
    }
    return undefined;
}

export function renderReferenceLinksHtml(references: AttachmentReference[]): string {
    const cards: string[] = [];
    for (const ref of references) {
        const href = buildReferenceUrl(ref);
        if (!href) continue;
        const name = escapeHtml(stripEigenExtension(ref.name));
        cards.push(
            '<div style="display:inline-block;border:1px solid #e0e0e0;border-radius:6px;padding:6px 10px;margin:4px 4px 4px 0;font-size:13px;font-family:sans-serif;color:#333;text-decoration:none;">' +
                `<a href="${escapeHtml(href)}" style="color:#333;text-decoration:none;">&#128206; ${name}</a>` +
                '</div>',
        );
    }
    if (cards.length === 0) return '';
    return `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #eee;">${cards.join('')}</div>`;
}
