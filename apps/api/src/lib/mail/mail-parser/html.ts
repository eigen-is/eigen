import type { EmailAddress } from '@workspace/lib/types/mail';
import he from 'he';
import { convert } from 'html-to-text';
import { findLinks } from './linkify';

// Both derivations (html→text in htmlToText, text→html in textToHtml) run synchronously on the shared event
// loop, on every message open and every sync pass, so a multi-MB body is a DoS lever. Only the derived output
// is cut off past this cap; the stored source part is never touched.
const MAX_HTML_TEXT_LENGTH = 2 * 1024 * 1024;

export type CidImage = { cid: string; contentType: string; content: Buffer };

export function htmlToText(html: string): string {
    return convert(html.slice(0, MAX_HTML_TEXT_LENGTH));
}

export function textToHtml(str: string): string {
    const body = linkifyText(str.slice(0, MAX_HTML_TEXT_LENGTH))
        .replace(/\r?\n/g, '\n')
        .trim()
        .replace(/[ \t]+$/gm, '')
        .trim()
        .replace(/\n\n+/g, '</p><p>')
        .trim()
        .replace(/\n/g, '<br/>');
    return `<p>${body}</p>`;
}

function encode(text: string): string {
    return he.encode(text, { useNamedReferences: true });
}

function linkifyText(str: string): string {
    const parts: string[] = [];
    let last = 0;
    for (const { start, end, href } of findLinks(str)) {
        parts.push(encode(str.slice(last, start)), `<a href="${encode(href)}">${encode(str.slice(start, end))}</a>`);
        last = end;
    }
    parts.push(encode(str.slice(last)));
    return parts.join('');
}

// Rewrites `cid:` references to the matching inline image into data URIs.
export function inlineCidImages(html: string, images: CidImage[]): string {
    return html.replace(/\bcid:([^'"\s]{1,256})/g, (match, cid: string) => {
        const image = images.find((img) => img.cid === cid && /^image\/[\w]+$/i.test(img.contentType));
        return image ? `data:${image.contentType};base64,${image.content.toString('base64')}` : match;
    });
}

export function addressesHtml(list: EmailAddress[]): string {
    return list
        .map((entry) => {
            let str = '<span class="mp_address_group">';
            if (entry.name)
                str += `<span class="mp_address_name">${he.encode(entry.name)}${entry.group ? ': ' : ''}</span>`;
            if (entry.address) {
                const link = `<a href="mailto:${he.encode(entry.address)}" class="mp_address_email">${he.encode(entry.address)}</a>`;
                str += entry.name ? ` &lt;${link}&gt;` : link;
            }
            if (entry.group) str += `${addressesHtml(entry.group)};`;
            return `${str}</span>`;
        })
        .join(', ');
}
