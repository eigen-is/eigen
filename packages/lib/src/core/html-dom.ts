// Browser-only HTML helpers — these depend on the DOM (`document`), so backend-shared
// code (anything importable by apps/api) must never import this module. The BE-safe HTML
// helpers (escapeHtml, stripTagsServer) live in ./html.
export function htmlToPlainText(html: string): string {
    // DOMParser, never a live-element innerHTML: callers feed untrusted clipboard HTML, and a
    // detached element still loads images and fires their onerror handlers — an inert parsed
    // document does neither.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.textContent ?? '';
}

// Tags the shared LightEditor (StarterKit, headings/code/hr disabled) actually keeps. Block nodes
// and the inline marks it renders; `<a>` is kept because Link is enabled. Everything else is
// unwrapped (children preserved) or dropped, so pasted rich HTML converges to LightEditor's schema.
const LIGHT_EDITOR_BLOCK_TAGS = new Set(['P', 'BLOCKQUOTE', 'UL', 'OL', 'LI']);
// Inline marks → their canonical element, so the stored HTML is born the way Tiptap re-serialises it
// (b→strong, i→em, del/strike→s) and a first edit is a no-op rather than a spurious diff.
const MARK_TAG_CANON: Record<string, string> = {
    STRONG: 'strong',
    B: 'strong',
    EM: 'em',
    I: 'em',
    U: 'u',
    S: 's',
    DEL: 's',
    STRIKE: 's',
};
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
// Elements whose CONTENT must be discarded entirely (never unwrapped — their text is code/markup).
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'HEAD', 'TITLE']);

// Only http(s)/mailto links survive — a javascript:/data:/vbscript: href is an XSS vector (the
// sanitized HTML is rendered via dangerouslySetInnerHTML by the canvas' rich-text layer). An unsafe
// href unwraps the anchor to its text.
function safeHref(href: string | null): string | null {
    if (!href) return null;
    const trimmed = href.trim();
    return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

function appendSanitized(node: Node, parent: HTMLElement): void {
    if (node.nodeType === Node.TEXT_NODE) {
        parent.appendChild(document.createTextNode(node.textContent ?? ''));
        return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName;

    if (DROP_TAGS.has(tag)) return;
    if (tag === 'BR') {
        parent.appendChild(document.createElement('br'));
        return;
    }
    const recurseInto = (target: HTMLElement) => {
        for (const child of Array.from(el.childNodes)) appendSanitized(child, target);
    };
    // Headings collapse to paragraphs (LightEditor has no heading node).
    if (HEADING_TAGS.has(tag)) {
        const p = document.createElement('p');
        recurseInto(p);
        parent.appendChild(p);
        return;
    }
    if (LIGHT_EDITOR_BLOCK_TAGS.has(tag)) {
        const clean = document.createElement(tag.toLowerCase());
        recurseInto(clean);
        parent.appendChild(clean);
        return;
    }
    const markTag = MARK_TAG_CANON[tag];
    if (markTag) {
        const clean = document.createElement(markTag);
        recurseInto(clean);
        parent.appendChild(clean);
        return;
    }
    if (tag === 'A') {
        const href = safeHref(el.getAttribute('href'));
        if (href) {
            const clean = document.createElement('a');
            // A link always opens in a new tab, with the opener sealed. Forced here rather than trusted
            // from the source markup: this is the one seam every rendered surface passes through, and a
            // canvas link that navigates in place would take a presenter out of their own deck. Written
            // in Tiptap's own serialisation order (Link merges its configured HTMLAttributes before
            // href), so a pasted link is already canonical and the first keystroke rewrites nothing.
            clean.setAttribute('target', '_blank');
            clean.setAttribute('rel', 'noopener noreferrer');
            clean.setAttribute('href', href);
            recurseInto(clean);
            parent.appendChild(clean);
            return;
        }
    }
    // Unknown/disallowed element (span, div, font, styled wrappers, unsafe <a>) — unwrap, keep
    // children. All attributes (style/class/data-*/on*) are dropped by never copying them.
    for (const child of Array.from(el.childNodes)) appendSanitized(child, parent);
}

// Alignment of pasted prose (docs → slides/vector). Docs' Tiptap TextAlign extension stores it as a
// block-level `style="text-align: X"` (parseHTML also reads the legacy `align` attr), which the
// LightEditor sanitizer strips along with every other attribute — so read it here, off the RAW html,
// before sanitizing. Returns the first top-level block's alignment when it's one of the four canonical
// values, else null (a default-left paragraph carries no style, so callers keep their own default).
const TEXT_ALIGN_VALUES = ['left', 'center', 'right', 'justify'] as const;
export function readDominantTextAlign(html: string): (typeof TEXT_ALIGN_VALUES)[number] | null {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of Array.from(doc.body.children)) {
        const raw = ((el as HTMLElement).style.textAlign || el.getAttribute('align') || '').trim().toLowerCase();
        const match = TEXT_ALIGN_VALUES.find((a) => a === raw);
        if (match) return match;
    }
    return null;
}

// Map arbitrary pasted HTML onto the LightEditor tag set (see the sets above): structural formatting
// and inline marks are kept, headings become paragraphs, everything else is unwrapped or dropped, and
// ALL attributes are stripped bar a safe `<a href>` and the new-tab pair forced onto it. DOM-based so escaping is automatic and there
// is no regex-parsing hazard. Returns '' when nothing survives (caller falls back to plain text).
export function sanitizeToLightEditorHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = document.createElement('div');
    for (const child of Array.from(doc.body.childNodes)) appendSanitized(child, out);
    return out.innerHTML;
}
