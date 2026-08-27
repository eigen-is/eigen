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

// Server-side HTML → plain-text. Browser code should use `htmlToPlainText` from
// ./html-dom, which delegates to the DOM parser; this regex variant is intended for
// Node/Bun where there's no `document`. Used by the email composers to populate the
// plain-text fallback (`OutboundMail.text`) for spam filters.
export function stripTagsServer(html: string): string {
    if (!html) return '';
    return html
        .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
