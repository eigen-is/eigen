// The `eigen-media:` refs a copied drawing's SVG names its images by, never by their bytes. A copy resolves them
// against its own media files, and the API's preview inliner swaps each for a data URI when it serves the SVG. A ref
// holds none of the characters escapeXml rewrites, since `'` is encoded too, so the stored SVG keeps it verbatim and
// every rewrite here is an exact string replace, never a parse.

import { CONTROL_CHARS } from '../validation/text';

export const EIGEN_MEDIA_SCHEME = 'eigen-media:';

// Loose up to the boundary, so a forged ref is captured whole and then refused by its parse.
const REF_SCAN = /eigen-media:[^\s"'<>]*/g;

export function eigenMediaHref(name: string): string {
    return EIGEN_MEDIA_SCHEME + encodeURIComponent(name).replace(/'/g, '%27');
}

// A media name is looked up beside the document, so a slash or a control character could reach outside it.
export function isSafeMediaName(name: string): boolean {
    return name !== '' && !name.includes('/') && !name.includes('\\') && !CONTROL_CHARS.test(name);
}

// The distinct safe media names an SVG references, in first-seen order.
export function listEigenMediaRefs(svg: string): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const match of svg.matchAll(REF_SCAN)) {
        const name = parseEigenMediaHref(match[0]);
        if (name !== null && !seen.has(name)) {
            seen.add(name);
            names.push(name);
        }
    }
    return names;
}

// The inverse of eigenMediaHref: the decoded media name, or null for another href, a malformed one or an unsafe name.
function parseEigenMediaHref(href: string): string | null {
    if (!href.startsWith(EIGEN_MEDIA_SCHEME)) return null;
    let name: string;
    try {
        name = decodeURIComponent(href.slice(EIGEN_MEDIA_SCHEME.length));
    } catch {
        return null; // malformed percent-encoding
    }
    return isSafeMediaName(name) ? name : null;
}

// Renames refs in one pass, so a swap such as a→b with b→a applies once and doesn't compose.
export function rewriteEigenMediaRefs(svg: string, renames: Map<string, string>): string {
    if (renames.size === 0) return svg;
    const tokens = new Map<string, string>();
    for (const [from, to] of renames) tokens.set(eigenMediaHref(from), eigenMediaHref(to));
    return svg.replace(REF_SCAN, (token) => tokens.get(token) ?? token);
}

// Replaces each named ref's whole href with another, such as a data URI.
export function replaceEigenMediaHrefs(svg: string, replacements: Map<string, string>): string {
    if (replacements.size === 0) return svg;
    let out = svg;
    for (const [name, href] of replacements) {
        out = out.split(` href="${eigenMediaHref(name)}"`).join(` href="${href}"`);
    }
    return out;
}

// Drops the href of every image that names one of `names`, so it draws nothing, as an image with no media does.
export function stripEigenMediaRefs(svg: string, names: Iterable<string>): string {
    let out = svg;
    for (const name of names) {
        out = out.split(` href="${eigenMediaHref(name)}"`).join('');
    }
    return out;
}
