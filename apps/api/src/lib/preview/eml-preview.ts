import {
    EML_PREVIEW_MAX_ATTACHMENTS,
    EML_PREVIEW_MAX_HTML_BYTES,
    EML_PREVIEW_MAX_INLINE_BYTES,
    EML_PREVIEW_MAX_TEXT_CHARS,
} from '@workspace/lib/constants/mail';
import type { AddressObject, ParsedMail } from '@workspace/lib/types/mail';
import type { EmlPreview } from '@workspace/lib/types/preview';
import DOMPurify from 'isomorphic-dompurify';
import { ApiError } from '../core/errors';
import { parseMail } from '../mail/mail-parser';

// A cached body is JSON this process wrote from a value it built, so the read back is a typed assignment,
// like the vCard preview's own cached JSON. Nothing else checks the shape: change EmlPreview or the
// sanitizer and bump EML_FORMAT (preview-cache.ts), or a restored previewsDir serves the old shape.
export const parseEmlPreview = (body: string): EmlPreview => JSON.parse(body);

// Minimal structural view of the jsdom element passed to DOMPurify hooks (as in export/sanitize.ts).
type AttrNode = {
    tagName?: string;
    textContent: string | null;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
};

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
const FORBID_TAGS = ['form', 'svg', 'math', 'video', 'audio', 'source', 'track', 'input', 'button', 'picture'];

const LINK_SCHEME = /^(?:https?:|mailto:)/i;
const CSS_FETCHES = /\\|@import|image-set|image\(|cross-fade|element\(/i;
const CSS_URL = /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;
const DATA_URI = /data:[^\s"'<>)]+/g;

const isDataUri = (value: string): boolean => /^\s*data:/i.test(value);

// CSS that can fetch is dropped whole rather than rewritten: a quick look can afford the fidelity loss,
// and a CSS escape spells the same token invisibly to a regex (`u\72l(` is `url(` to the parser), so a
// backslash is a refusal on its own.
function cssFetches(css: string): boolean {
    return CSS_FETCHES.test(css) || [...css.matchAll(CSS_URL)].some(([, , url]) => !isDataUri(url));
}

function restrictNode(node: AttrNode, inlineImages: boolean): void {
    const style = node.getAttribute('style');
    if (style !== null && cssFetches(style)) node.removeAttribute('style');

    const anchor = node.tagName === 'A';
    for (const attr of REF_ATTRS) {
        if (anchor && attr === 'href') continue;
        const value = node.getAttribute(attr);
        if (value !== null && !(inlineImages && isDataUri(value))) node.removeAttribute(attr);
    }

    if (anchor) {
        const href = node.getAttribute('href');
        if (href !== null && !LINK_SCHEME.test(href.trim())) node.removeAttribute('href');
        // A quick look is not the reader: every link leaves the app, and none of them keeps a handle on it.
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
    }
}

// The reader's config (mail-parse.ts) plus an allowlist inside the sanitizer's own DOM: a regex over
// serialized HTML would void DOMPurify's output guarantee. The hooks are scoped to this synchronous call
// (add → sanitize → remove) because they are global to the instance.
function sanitizeEmlHtml(html: string, inlineImages: boolean): string {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => restrictNode(node as unknown as AttrNode, inlineImages));
    DOMPurify.addHook('uponSanitizeElement', (node, data) => {
        if (data.tagName !== 'style') return;
        const element = node as unknown as AttrNode;
        if (cssFetches(element.textContent ?? '')) element.textContent = '';
    });
    try {
        return DOMPurify.sanitize(html, { FORCE_BODY: true, ADD_ATTR: ['target'], FORBID_TAGS }) as string;
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
//
// The payload makes no request when it renders: the html is filtered down to data: references and
// <a href>s, and no part bytes ride along.
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

// The parser bounds neither side of the body: it leaves the html unbounded and inlineCidImages copies one
// cid's bytes per reference, so a small image named 200 times is 200 copies. Over the inline budget the
// images are cut from the source before the DOM pass — they simply do not show — and a sanitized body
// still over the payload ceiling is dropped for the text one.
function boundedHtml(html: string): string | null {
    const inlineBytes = [...html.matchAll(DATA_URI)].reduce((sum, [uri]) => sum + uri.length, 0);
    const inlineImages = inlineBytes <= EML_PREVIEW_MAX_INLINE_BYTES;
    const sanitized = sanitizeEmlHtml(inlineImages ? html : html.replace(DATA_URI, ''), inlineImages);
    return Buffer.byteLength(sanitized) > EML_PREVIEW_MAX_HTML_BYTES ? null : sanitized;
}
