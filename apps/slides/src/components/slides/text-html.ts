// Helpers for moving between plain text and the HTML stored in a TextObject's `text` field.
// LightEditor reads/writes HTML; external paste, clipboard previews, and comment anchors
// are still plain text and need conversion at the boundary.

export function escapeHtml(text: string): string {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
}

export function htmlToPlainText(html: string): string {
    if (typeof document === 'undefined') return html.replace(/<[^>]+>/g, '');
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent ?? '';
}
