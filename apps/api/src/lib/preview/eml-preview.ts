import {
    EML_PREVIEW_MAX_ATTACHMENTS,
    EML_PREVIEW_MAX_HTML_BYTES,
    EML_PREVIEW_MAX_TEXT_CHARS,
} from '@workspace/lib/constants/mail';
import type { AddressObject, ParsedMail } from '@workspace/lib/types/mail';
import type { EmlPreview } from '@workspace/lib/types/preview';
import DOMPurify from 'isomorphic-dompurify';
import { ApiError } from '../core/errors';
import type { AttrNode } from '../export/sanitize';
import { READER_SANITIZE_CONFIG } from '../mail/mail-parse';
import { parseMail } from '../mail/mail-parser';

export const parseEmlPreview = (body: string): EmlPreview => JSON.parse(body);

// Fetched without a click, on any element DOMPurify keeps. `href` is here for SVG <image>/<use> and for
// <link>; an <a> keeps its link through the branch below.
const REF_ATTRS = [
    'src',
    'srcset',
    'poster',
    'background',
    'href',
    'xlink:href',
    'action',
    'formaction',
    'ping',
    'cite',
    'longdesc',
    'usemap',
    'data',
];

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
const CSS_FETCHES = /\\|@import|image-set|image\(|cross-fade|element\(/i;
// The one reference a message may keep: a raster image the parser inlined. An SVG or HTML data: URI is a
// document tree of its own, and only the browser's SVG-as-image rules would stand between it and a fetch.
const RASTER_DATA_URI = String.raw`data:image\/(?:png|jpe?g|gif|webp|avif|bmp)[;,]`;
const INLINE_IMAGE = new RegExp(`^\\s*${RASTER_DATA_URI}`, 'i');
const CSS_REMOTE_URL = new RegExp(`url\\((?!\\s*(?:['"]\\s*)?${RASTER_DATA_URI})`, 'i');
const DATA_URI = /data:[^\s"'<>)]+/g;

// Both refusals read a token, never a pair: a CSS escape spells `url(` invisibly to a regex (`u\72l(`), and
// an unterminated `url(` fetches without ever closing.
function cssFetches(css: string): boolean {
    return CSS_FETCHES.test(css) || CSS_REMOTE_URL.test(css);
}

function restrictNode(node: AttrNode): void {
    const style = node.getAttribute('style');
    if (style !== null && cssFetches(style)) node.removeAttribute('style');

    const anchor = node.tagName === 'A';
    for (const attr of REF_ATTRS) {
        if (anchor && attr === 'href') continue;
        const value = node.getAttribute(attr);
        if (value !== null && !INLINE_IMAGE.test(value)) node.removeAttribute(attr);
    }

    if (anchor) {
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
        if (data.tagName === 'style' && cssFetches(node.textContent ?? '')) node.textContent = '';
    });
    try {
        return DOMPurify.sanitize(html, { ...READER_SANITIZE_CONFIG, FORBID_TAGS });
    } finally {
        DOMPurify.removeHook('afterSanitizeAttributes');
        DOMPurify.removeHook('uponSanitizeElement');
    }
}

// The single AddressObject a header carries: the parser hands back an array when a message repeats the
// header, and the last one is what the reader's own envelope rows show.
function oneAddress(value: AddressObject | AddressObject[] | undefined): AddressObject | null {
    return (Array.isArray(value) ? value.at(-1) : value) ?? null;
}

// File bytes → the message an .eml preview serves. Runs inside the transform Worker (worker.ts owns
// execution; the main-thread orchestration lives in preview-cache.ts). This module must not reach the
// Mount or the transform seam — the Worker imports it.
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
        to: oneAddress(parsed.to),
        cc: oneAddress(parsed.cc),
        date: parsed.date?.toISOString() ?? null,
        html: parsed.html === null ? null : boundedHtml(parsed.html),
        text: parsed.text?.slice(0, EML_PREVIEW_MAX_TEXT_CHARS) ?? null,
        attachments: parsed.attachments
            .slice(0, EML_PREVIEW_MAX_ATTACHMENTS)
            .map(({ filename, contentType, size }) => ({ filename, contentType, size })),
        droppedAttachments: Math.max(parsed.attachments.length - EML_PREVIEW_MAX_ATTACHMENTS, 0),
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
