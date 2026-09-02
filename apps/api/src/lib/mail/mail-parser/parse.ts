import { IMIP_METHODS } from '@workspace/lib/types/calendar';
import type { AddressObject, Attachment, ParsedMail } from '@workspace/lib/types/mail';
import he from 'he';
import libmime from 'libmime';
import { decodeText, decodeTransfer } from './decode';
import { addressesHtml, type CidImage, htmlToText, inlineCidImages, textToHtml } from './html';
import { type MimePart, splitMime } from './split';

// Parts rendered into the message body when inline; everything else is an attachment.
const TEXT_TYPES = new Set(['text/plain', 'text/html', 'message/delivery-status']);

export function parseMail(bytes: Buffer): ParsedMail {
    const root = splitMime(bytes);
    const attachments: Attachment[] = [];
    const cidImages: CidImage[] = [];
    const bodies = new Map<MimePart, string>();
    let hasText = false;
    let hasHtml = false;

    const collect = (part: MimePart): void => {
        if (!part.embedsMessage && !part.contentType.startsWith('multipart/')) {
            const { headers, contentType } = part;
            const declared = headers.contentDisposition.value;
            const inline = declared ? declared === 'inline' : TEXT_TYPES.has(contentType);

            if (inline && TEXT_TYPES.has(contentType)) {
                bodies.set(part, decodeText(part.body, headers));
                if (contentType === 'text/html') hasHtml = true;
                else hasText = true;
            } else {
                const filename =
                    libmime.decodeWords(
                        headers.contentDisposition.params['filename'] || headers.contentType.params['name'] || '',
                    ) || undefined;
                const content = decodeTransfer(part.body, headers.transferEncoding);
                const attachment: Attachment = {
                    contentType:
                        contentType === 'application/octet-stream' && filename
                            ? libmime.detectMimeType(filename)
                            : contentType,
                    filename,
                    content,
                    size: content.length,
                };
                if (attachment.contentType.startsWith('text/calendar')) {
                    const method = headers.contentType.params['method']?.toUpperCase();
                    const calendarMethod = IMIP_METHODS.find((known) => known === method);
                    if (calendarMethod) attachment.calendarMethod = calendarMethod;
                }
                attachments.push(attachment);
                if (headers.contentId) {
                    cidImages.push({
                        cid: headers.contentId.replace(/^<|>$/g, '').trim(),
                        contentType: attachment.contentType,
                        content,
                    });
                }
            }
        }
        for (const child of part.children) collect(child);
    };

    const text: string[] = [];
    const html: string[] = [];

    // An inline forwarded message shows its own envelope above its body.
    const renderMessageMeta = (headers: MimePart['headers']): void => {
        const rows: { key: string; text: string; html: string }[] = [];
        const addressRow = (key: string, value: AddressObject | AddressObject[] | undefined): void => {
            const single = Array.isArray(value) ? value.at(-1) : value;
            if (single) rows.push({ key, text: single.text, html: addressesHtml(single.value) });
        };
        addressRow('From', headers.from);
        if (headers.subject !== undefined) {
            rows.push({
                key: 'Subject',
                text: headers.subject,
                html: `<strong>${he.encode(headers.subject)}</strong>`,
            });
        }
        if (headers.date)
            rows.push({ key: 'Date', text: headers.date.toUTCString(), html: headers.date.toUTCString() });
        addressRow('To', headers.to);
        addressRow('Cc', headers.cc);
        addressRow('Bcc', headers.bcc);

        if (hasHtml) {
            const cells = rows.map(
                (row) => `<tr><td class="mp_head_key">${row.key}:</td><td class="mp_head_value">${row.html}</td></tr>`,
            );
            html.push(`<table class="mp_head">${cells.join('\n')}</table>`);
        }
        if (hasText) text.push(`\n${rows.map((row) => `${row.key}: ${row.text}`).join('\n')}\n`);
    };

    const render = (part: MimePart, alternative: boolean): void => {
        if (part.parent?.embedsMessage) renderMessageMeta(part.headers);
        const body = bodies.get(part);
        if (body) {
            if (part.contentType === 'text/html') {
                if ((!alternative && hasText) || (part.parent === null && !hasText)) text.push(htmlToText(body));
                html.push(body);
            } else {
                text.push(body);
                if (!alternative && hasHtml) html.push(textToHtml(body));
            }
        }
        const inAlternative = alternative || part.contentType === 'multipart/alternative';
        for (const child of part.children) render(child, inAlternative);
    };

    collect(root);
    render(root, false);

    const { headers } = root;
    return {
        attachments,
        html: html.length ? inlineCidImages(html.join('<br/>\n'), cidImages) : null,
        text: text.length ? text.join('\n') : undefined,
        textAsHtml: text.length ? text.map(textToHtml).join('<br/>\n') : undefined,
        subject: headers.subject,
        date: headers.date,
        from: headers.from,
        to: headers.to,
        cc: headers.cc,
        bcc: headers.bcc,
        replyTo: headers.replyTo,
        messageId: headers.messageId,
        inReplyTo: headers.inReplyTo,
        references: headers.references,
    };
}
