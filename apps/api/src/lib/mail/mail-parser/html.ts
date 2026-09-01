import type { EmailAddress } from '@workspace/lib/types/mail';
import he from 'he';
import { convert } from 'html-to-text';
import LinkifyIt from 'linkify-it';
import tlds from 'tlds';

// htmlToText runs synchronously at ~70-90 ms/MB on the shared event loop, on every message open and every
// sync pass, so a multi-MB HTML body is a DoS lever. The rendered html stays whole; only the derived
// plaintext is cut off past the cap.
const MAX_HTML_TEXT_LENGTH = 2 * 1024 * 1024;

export type CidImage = { cid: string; contentType: string; content: Buffer };

const linkify = new LinkifyIt()
    .tlds(tlds)
    .tlds('onion', true)
    .add('git:', 'http:')
    .add('ftp:', null)
    .set({ fuzzyIP: true, fuzzyLink: true, fuzzyEmail: true })
    .add('@', {
        validate(text, pos, self) {
            const tail = text.slice(pos);
            if (!self.re['bluesky']) {
                self.re['bluesky'] = new RegExp(
                    `^([a-zA-Z0-9_][a-zA-Z0-9._-]*[a-zA-Z0-9])(?=$|${self.re['src_ZPCc']})`,
                );
            }
            const match = self.re['bluesky'].exec(tail);
            if (!match) return 0;
            if (pos >= 2 && tail[pos - 2] === '@') return false;
            return match[0].length;
        },
        normalize(match) {
            match.url = `https://bsky.app/profile/${match.url.replace(/^@/, '')}`;
        },
    });

export function htmlToText(html: string): string {
    return convert(html.slice(0, MAX_HTML_TEXT_LENGTH));
}

export function textToHtml(str: string): string {
    const encoded = linkify.pretest(str) ? linkifyText(str) : he.encode(str, { useNamedReferences: true });
    const body = encoded
        .replace(/\r?\n/g, '\n')
        .trim()
        .replace(/[ \t]+$/gm, '')
        .trim()
        .replace(/\n\n+/g, '</p><p>')
        .trim()
        .replace(/\n/g, '<br/>');
    return `<p>${body}</p>`;
}

function linkifyText(str: string): string {
    const parts: string[] = [];
    let last = 0;
    for (const link of linkify.match(str) ?? []) {
        parts.push(he.encode(str.slice(last, link.index), { useNamedReferences: true }));
        parts.push(`<a href="${link.url}">${link.text}</a>`);
        last = link.lastIndex;
    }
    parts.push(he.encode(str.slice(last), { useNamedReferences: true }));
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
