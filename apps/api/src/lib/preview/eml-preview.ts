import {
    FETCHING_ATTRS,
    LINK_TAGS,
    restrictSheet,
    sheetText,
    stripRemoteRefs,
} from '@workspace/lib/mail/remote-content';
import type { ParsedMail } from '@workspace/lib/types/mail';
import type { EmlPreview } from '@workspace/lib/types/preview';
import DOMPurify from 'isomorphic-dompurify';
import { ApiError } from '../core/errors';
import { READER_SANITIZE_CONFIG } from '../mail/mail-parse';
import { parseMail } from '../mail/mail-parser';

// What one `.eml` preview may carry. The parser bounds none of them: it leaves the body unbounded and
// copies an inlined `cid:` image once per reference, so the builder is where the payload is bounded.
export const EML_PREVIEW_MAX_ATTACHMENTS = 50;
export const EML_PREVIEW_MAX_HTML_BYTES = 2 * 1024 * 1024;
// A character count, like the parser's own body ceilings (mail-parser/html.ts).
export const EML_PREVIEW_MAX_TEXT_CHARS = 1024 * 1024;

export const parseEmlPreview = (body: string): EmlPreview => JSON.parse(body);

// On top of what renders: what a click or a reader of the source follows.
const REF_ATTRS = [...FETCHING_ATTRS, 'action', 'formaction', 'ping', 'cite', 'longdesc', 'usemap'];

// Tags on top of the reader's own <form> refusal: each one fetches (media, <picture>/<source>, <input
// type=image>) or carries a second document tree DOMPurify's URL rules do not reach into (SVG, MathML).
const FORBID_TAGS = [
    ...READER_SANITIZE_CONFIG.FORBID_TAGS,
    'svg',
    'math',
    'video',
    'audio',
    'source',
    'track',
    'input',
    'button',
    'picture',
];

const LINK_SCHEME = /^(?:https?:|mailto:)/i;
const DATA_URI = /data:[^\s"'<>)]+/g;

function restrictNode(node: Element): void {
    stripRemoteRefs(node, REF_ATTRS);

    if (LINK_TAGS.has(node.localName)) {
        const href = node.getAttribute('href');
        if (href !== null && !LINK_SCHEME.test(href.trim())) node.removeAttribute('href');
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
    }
}

// The reader's config (mail-parse.ts) plus an allowlist inside the sanitizer's own DOM: a regex over
// serialized HTML would void DOMPurify's output guarantee. The hooks are scoped to this synchronous call
// (add → sanitize → remove) because they are global to the instance.
function sanitizeEmlHtml(html: string): string {
    DOMPurify.addHook('afterSanitizeAttributes', restrictNode);
    DOMPurify.addHook('uponSanitizeElement', (node, data) => {
        if (data.tagName === 'style') node.textContent = restrictSheet(sheetText(node));
    });
    try {
        return DOMPurify.sanitize(html, { ...READER_SANITIZE_CONFIG, FORBID_TAGS });
    } finally {
        DOMPurify.removeHook('afterSanitizeAttributes');
        DOMPurify.removeHook('uponSanitizeElement');
    }
}

// File bytes → the message an .eml preview serves.
export function buildEmlPreviewPayload(data: ArrayBuffer): EmlPreview {
    let parsed: ParsedMail;
    try {
        parsed = parseMail(Buffer.from(data));
    } catch {
        throw new ApiError(422, 'Could not read this file');
    }

    return {
        subject: parsed.subject ?? '',
        from: parsed.from ?? null,
        to: parsed.to ?? null,
        cc: parsed.cc ?? null,
        date: parsed.date?.toISOString() ?? null,
        html: parsed.html === null ? null : boundedHtml(parsed.html),
        text: parsed.text?.slice(0, EML_PREVIEW_MAX_TEXT_CHARS) ?? null,
        attachments: parsed.attachments
            .slice(0, EML_PREVIEW_MAX_ATTACHMENTS)
            .map(({ filename, contentType, size }) => ({ filename, contentType, size })),
        remainingAttachments: Math.max(parsed.attachments.length - EML_PREVIEW_MAX_ATTACHMENTS, 0),
    };
}

// One ceiling, measured on the way in: an oversize body is measured again without its inlined images, so a
// heavier message never shows less than a lighter one and nothing over the ceiling reaches the sanitizer.
function boundedHtml(html: string): string | null {
    const body = Buffer.byteLength(html) > EML_PREVIEW_MAX_HTML_BYTES ? html.replace(DATA_URI, '') : html;
    if (Buffer.byteLength(body) > EML_PREVIEW_MAX_HTML_BYTES) return null;
    const sanitized = sanitizeEmlHtml(body);
    return Buffer.byteLength(sanitized) > EML_PREVIEW_MAX_HTML_BYTES ? null : sanitized;
}
