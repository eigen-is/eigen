// HTML as strings, for browser and server code alike: escaping, plain text to paragraphs and back, and the tags and
// attributes a LightEditor body keeps, which the canvas and the API's exports filter to. The DOM-based helpers live
// beside it in html-dom.

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Exact inverse of escapeHtml, for the one case that needs it: code that measures or
// inspects escaped text and must see what the browser renders rather than the markup.
// `&amp;` decodes last so an escaped `&amp;lt;` comes back as the literal `&lt;` it was,
// instead of turning into a `<`.
export function unescapeHtml(html: string): string {
    return html
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

// Plain text → paragraph HTML, the inverse of stripTagsServer: one <p> per line, escaped. The one
// builder for "this text becomes a rich-text body" (the canvas' text paste, the demo builder).
export function textToParagraphHtml(text: string): string {
    return text
        .split('\n')
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('');
}

// Server-side HTML → plain-text. Browser code should use `htmlToPlainText` from
// ./html-dom, which delegates to the DOM parser; this regex variant is intended for
// Node/Bun where there's no `document`. Used by the email composers to populate the
// plain-text fallback (`OutboundMail.text`) for spam filters.
export function stripTagsServer(html: string): string {
    if (!html) return '';
    const text = dropRawTextElements(html)
        .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        // `[^<>]`, not `[^>]`: a `<` no `>` follows would rescan the rest of the input from every `<`.
        .replace(/<[^<>]+>/g, '');
    // `&nbsp;` is not one of escapeHtml's five, so it stays here; the rest decode through
    // the shared inverse, which decodes `&amp;` LAST. Doing it first, as this used to,
    // turned an escaped `&amp;lt;` into a `<` the source never contained.
    return unescapeHtml(text.replace(/&nbsp;/gi, ' '))
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Dropped whole, content included: the parser reads their content as raw text up to the first matching
// end tag, and it is code or a fallback no page shows. ./html-dom's DROP_TAGS starts from these.
export const RAW_TEXT_DROP_TAGS = ['script', 'style', 'noscript', 'iframe', 'title'] as const;
const RAW_TEXT_START = new RegExp(`<(${RAW_TEXT_DROP_TAGS.join('|')})(?=[\\t\\n\\f\\r />])`, 'gi');
const RAW_TEXT_END: Record<string, RegExp> = Object.fromEntries(
    RAW_TEXT_DROP_TAGS.map((tag) => [tag, new RegExp(`</${tag}(?=[\\t\\n\\f\\r />])`, 'gi')]),
);

// One forward pass: an element left open, or an end tag no `>` closes, swallows the rest, as it does
// in the parser.
function dropRawTextElements(html: string): string {
    let kept = '';
    let from = 0;
    RAW_TEXT_START.lastIndex = 0;
    for (let start = RAW_TEXT_START.exec(html); start; start = RAW_TEXT_START.exec(html)) {
        kept += html.slice(from, start.index);
        const end = RAW_TEXT_END[start[1].toLowerCase()];
        end.lastIndex = RAW_TEXT_START.lastIndex;
        const gt = end.exec(html) ? html.indexOf('>', end.lastIndex) : -1;
        if (gt < 0) return kept;
        from = RAW_TEXT_START.lastIndex = gt + 1;
    }
    return kept + html.slice(from);
}

// What the shared LightEditor's schema keeps: its block nodes, the inline marks it renders, `<a>`
// (Link is enabled) and `<br>` — plus the only three attributes that survive, all of them the anchor's.
// The canvas mounts a rich-text box's `html` through the LightEditor sanitizer in ./html-dom while the
// API renders the same string into exports and previews, so both filter to this one list; two lists
// would mean a `<table>` or an `<img src="data:…">` a peer wrote is invisible live and printed anyway.
// The base set: a comment-card LightEditor also enables taskList, and ./html-dom's
// sanitizeCommentCardHtml keeps that structure on top of these — nothing on the API renders one.
export const LIGHT_EDITOR_BLOCK_TAGS = ['p', 'blockquote', 'ul', 'ol', 'li'] as const;
export const LIGHT_EDITOR_MARK_TAGS = ['strong', 'em', 'u', 's'] as const;
export const LIGHT_EDITOR_TAGS: string[] = [...LIGHT_EDITOR_BLOCK_TAGS, ...LIGHT_EDITOR_MARK_TAGS, 'a', 'br'];
export const LIGHT_EDITOR_ATTRS = ['href', 'target', 'rel'];

// The only href schemes a LightEditor anchor keeps — a javascript:/data:/vbscript: href is an XSS
// vector, and the sanitized HTML is rendered through dangerouslySetInnerHTML by the canvas' rich-text
// layer and the comment-card notes, and injected as live DOM in the drive hero.
export const LIGHT_EDITOR_HREF = /^(https?:|mailto:)/i;

// A DOM walk meets text and comments too; the element nodes are the ones with tags and attributes.
export function isElement(node: Node): node is Element {
    return node.nodeType === 1;
}
