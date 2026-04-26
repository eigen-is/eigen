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
