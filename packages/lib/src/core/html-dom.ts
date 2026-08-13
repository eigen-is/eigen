// Browser-only HTML helpers — these depend on the DOM (`document`), so backend-shared
// code (anything importable by apps/api) must never import this module. The BE-safe HTML
// helpers (escapeHtml, stripTagsServer) live in ./html.
export function htmlToPlainText(html: string): string {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent ?? '';
}
