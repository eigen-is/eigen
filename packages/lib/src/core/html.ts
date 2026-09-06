export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// XML text/attribute escaping, for everything that writes XML by hand: the SVG the canvas kinds
// serialize, and the API's WebDAV/CalDAV response builders and S3 bucket-configuration bodies. It is
// NOT escapeHtml — XML's five predefined entities include `&apos;`, where HTML wants the numeric
// `&#39;` — so the two live side by side rather than one pretending to be the other.
export function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
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
    const text = html
        .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '');
    // `&nbsp;` is not one of escapeHtml's five, so it stays here; the rest decode through
    // the shared inverse, which decodes `&amp;` LAST. Doing it first, as this used to,
    // turned an escaped `&amp;lt;` into a `<` the source never contained.
    return unescapeHtml(text.replace(/&nbsp;/gi, ' '))
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// What the shared LightEditor's schema keeps: its block nodes, the inline marks it renders, `<a>`
// (Link is enabled) and `<br>` — plus the only three attributes that survive, all of them the anchor's.
// The canvas mounts a rich-text box's `html` through the LightEditor sanitizer in ./html-dom while the
// API renders the same string into exports and previews, so both filter to this one list; two lists
// would mean a `<table>` or an `<img src="data:…">` a peer wrote is invisible live and printed anyway.
export const LIGHT_EDITOR_BLOCK_TAGS = ['p', 'blockquote', 'ul', 'ol', 'li'] as const;
export const LIGHT_EDITOR_MARK_TAGS = ['strong', 'em', 'u', 's'] as const;
export const LIGHT_EDITOR_TAGS: string[] = [...LIGHT_EDITOR_BLOCK_TAGS, ...LIGHT_EDITOR_MARK_TAGS, 'a', 'br'];
export const LIGHT_EDITOR_ATTRS = ['href', 'target', 'rel'];

// The only href schemes a LightEditor anchor keeps — a javascript:/data:/vbscript: href is an XSS
// vector, and the sanitized HTML is rendered through dangerouslySetInnerHTML by the canvas' rich-text
// layer and injected as live DOM in the drive hero.
export const LIGHT_EDITOR_HREF = /^(https?:|mailto:)/i;
