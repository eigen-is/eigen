import { escapeHtml } from '@workspace/lib/html';
import { getFontCSS } from './fonts';
import { EXPORT_CSP, sanitizeExportHtml } from './sanitize';

// The data-only rule as a <meta>, so it still holds once a download is saved and opened.
const EXPORT_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`;

// What an HTML export is for: the download a browser opens, or the document WeasyPrint prints.
export type HtmlExportMode = 'screen' | 'pdf';

// A link opens in a new tab, as in the editors. DOMPurify drops target by default; Eigen writes it beside
// rel="noopener noreferrer", so it is tabnabbing-safe, and WeasyPrint ignores it.
const KEEP_LINK_TARGETS = { ADD_ATTR: ['target'] };

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">';

// Every HTML download and every PDF's HTML: one self-contained document, the bundled fonts first in its stylesheet,
// because neither a saved file nor WeasyPrint has an app to fetch from. The body carries collaborator strings, so it
// is sanitized here; the stylesheet is generated.
export function exportHtmlDocument({
    title,
    css,
    body,
    viewport = false,
}: {
    title: string;
    css: string;
    body: string;
    viewport?: boolean;
}): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    ${EXPORT_CSP_META}${viewport ? `\n    ${VIEWPORT_META}` : ''}
    <title>${escapeHtml(title)}</title>
    <style>${getFontCSS()}${css}</style>
</head>
<body>
    ${sanitizeExportHtml(body, KEEP_LINK_TARGETS)}
</body>
</html>`;
}
