export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function htmlToPlainText(html: string): string {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent ?? '';
}

// Server-side HTML → plain-text. Browser code should keep using `htmlToPlainText`
// which delegates to the DOM parser; this regex variant is intended for Node/Bun
// where there's no `document`. Used by the email composers to populate the
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
