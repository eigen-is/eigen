// The one HTML document every export builds, for each type's HTML download and the HTML WeasyPrint prints: the
// doctype, the data-only policy, the title and the bundled fonts its text draws in, around a type's stylesheet and
// sanitized body.

import { EIGEN_FONT_NAMES } from '@workspace/lib/constants/fonts';
import { escapeHtml } from '@workspace/lib/html';
import { fontFaceCssOf } from './fonts';
import { EXPORT_CSP, KEEP_MATHML, sanitizeExportHtml } from './sanitize';

// The data-only rule as a <meta>, so it still holds once a download is saved and opened.
const EXPORT_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`;

// A link opens in a new tab, as in the editors. DOMPurify drops target by default; Eigen writes it beside
// rel="noopener noreferrer", so it is tabnabbing-safe, and WeasyPrint ignores it.
const KEEP_LINK_TARGETS = { ADD_ATTR: ['target'] };

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">';

// Every HTML download and every PDF's HTML: one self-contained document, the bundled fonts first in its stylesheet,
// because neither a saved file nor WeasyPrint has an app to fetch from. A face is up to 0.6 MB of base64, which
// WeasyPrint reads on every PDF, so the document embeds only the families its text can draw in: `cssFamilies`, which
// the type's stylesheet draws in, and each bundled family the body names, such as a cell's style, a font mark or a
// chart's SVG. Body text that names a family embeds it for nothing, and no family is missed. The body carries
// collaborator strings, so it is sanitized here; the stylesheet is generated.
export function exportHtmlDocument({
    title,
    css,
    body,
    viewport = false,
    cssFamilies,
}: {
    title: string;
    css: string;
    body: string;
    viewport?: boolean;
    cssFamilies: Iterable<string>;
}): string {
    const sanitized = sanitizeExportHtml(body, { ...KEEP_LINK_TARGETS, ...KEEP_MATHML });
    const families = new Set(cssFamilies);
    for (const name of EIGEN_FONT_NAMES) if (sanitized.includes(name)) families.add(name);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    ${EXPORT_CSP_META}${viewport ? `\n    ${VIEWPORT_META}` : ''}
    <title>${escapeHtml(title)}</title>
    <style>${fontFaceCssOf(families)}${css}</style>
</head>
<body>
    ${sanitized}
</body>
</html>`;
}
