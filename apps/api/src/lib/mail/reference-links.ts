// The links to Drive documents a message carries, drawn as "Open …" pills in its HTML. An outgoing copy gets bare pills.
// A saved draft gets them inside a block that also holds the references as data, so the draft's own file is the only
// copy of them and an IMAP client sees the links. The draft save writes the block and the reader's parse cuts it out.

import { MAX_SEND_REFERENCES } from '@workspace/lib/constants/mail';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import { isAttachmentReferenceShape } from '@workspace/lib/types/drive-reference';
import { renderAttachmentPills } from '../mailer/mail-template';

const BLOCK_START = '<!--eigen-refs:';
const COMMENT_END = '-->';
const BLOCK_END = '<!--/eigen-refs-->';

export function appendReferenceLinks(html: string, refs: AttachmentReference[], recipientEmail?: string): string {
    return beforeBodyEnd(html, renderAttachmentPills(refs, recipientEmail));
}

// Base64url, because a file name may hold `--`, which ends an HTML comment.
export function appendDraftReferences(html: string, refs: AttachmentReference[]): string {
    if (refs.length === 0) return html;
    const data = Buffer.from(JSON.stringify(refs)).toString('base64url');
    return beforeBodyEnd(html, `${BLOCK_START}${data}${COMMENT_END}${renderAttachmentPills(refs)}${BLOCK_END}`);
}

// An IMAP client or a mail moved into Drafts can write this block. Anything but a whole, valid one leaves the HTML as it
// is, so its pills stay plain links. Ours comes last, after anything a body quotes, and no scan here can backtrack.
export function cutDraftReferences(html: string): { html: string; driveReferences: AttachmentReference[] } {
    const uncut = { html, driveReferences: [] };
    const start = html.lastIndexOf(BLOCK_START);
    if (start < 0) return uncut;
    const dataStart = start + BLOCK_START.length;
    const dataEnd = html.indexOf(COMMENT_END, dataStart);
    if (dataEnd < 0) return uncut;
    const end = html.indexOf(BLOCK_END, dataEnd);
    if (end < 0) return uncut;
    const driveReferences = decodeReferences(html.slice(dataStart, dataEnd));
    if (!driveReferences) return uncut;
    return { html: html.slice(0, start) + html.slice(end + BLOCK_END.length), driveReferences };
}

function decodeReferences(data: string): AttachmentReference[] | null {
    let refs: unknown;
    try {
        refs = JSON.parse(Buffer.from(data, 'base64url').toString());
    } catch {
        return null;
    }
    return Array.isArray(refs) && refs.length <= MAX_SEND_REFERENCES && refs.every(isAttachmentReferenceShape)
        ? refs
        : null;
}

function beforeBodyEnd(html: string, block: string): string {
    const replaced = html.replace(/<\/body>/i, () => `${block}</body>`);
    return replaced !== html ? replaced : html + block;
}
