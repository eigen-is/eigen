// The `eigen-media:` ref codec for image-bearing vector SVGs. A copied
// selection's SVG references each image BY NAME — `href="eigen-media:<encodeURIComponent(name)>"` —
// never by bytes; the stored .svg keeps those refs so a container copy resolves them against the
// copy's own media/ siblings, and the display path (the API preview inliner) swaps each ref for a
// `data:` URI at serve time. Pure string ops, no XML parsing.
//
// escapeXml invariance is the load-bearing property: sceneToSvg writes `href="${escapeXml(href)}"`,
// and escapeXml touches `& < > " '`. encodeURIComponent already percent-encodes `& < > "` and space,
// leaving only `'` raw — so eigenMediaHref also encodes `'` to %27. The resulting token contains none
// of escapeXml's characters, so the SVG stores the token verbatim and rewrite/strip are exact-token
// string replaces, never a parse-and-reserialize.

export const EIGEN_MEDIA_SCHEME = 'eigen-media:';

// Every ref in an SVG, permissive to the boundary so a FORGED token (raw `/`, unencoded chars) is
// captured whole and then rejected by parse. A real eigenMediaHref token contains no whitespace,
// quote, or angle bracket (all percent-encoded), so this matches ours exactly too.
const REF_SCAN = /eigen-media:[^\s"'<>]*/g;

// name → `eigen-media:<encoded>`. Called by buildSelectionData's resolveMedia (the copy path)
// and by the preview inliner to rebuild a ref's exact search token.
export function eigenMediaHref(name: string): string {
    return EIGEN_MEDIA_SCHEME + encodeURIComponent(name).replace(/'/g, '%27');
}

// `eigen-media:<encoded>` → the decoded media name, or null when the href is not an eigen-media ref,
// is malformed, or decodes to an unsafe name. Unsafe = contains `/`, `\`, or a control char — the
// traversal/injection guard the preview inliner rides so a same-folder getChildByName lookup
// can never escape the container. The symmetric inverse of eigenMediaHref; backs listEigenMediaRefs.
export function parseEigenMediaHref(href: string): string | null {
    if (!href.startsWith(EIGEN_MEDIA_SCHEME)) return null;
    let name: string;
    try {
        name = decodeURIComponent(href.slice(EIGEN_MEDIA_SCHEME.length));
    } catch {
        return null; // malformed percent-encoding
    }
    if (name.length === 0) return null;
    if (name.includes('/') || name.includes('\\')) return null;
    for (let i = 0; i < name.length; i++) {
        const code = name.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) return null; // control character
    }
    return name;
}

// The distinct, safe media names an SVG references, in first-seen order. Forged/unsafe refs are
// dropped (parse returns null). Called by the preview inliner to enumerate the siblings to resolve.
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

// Rewrite each `eigen-media:` ref whose current name is a key of `renames` to its new name — one
// swap-safe pass (a rename chain like a→b, b→a is applied once, not composed). A token absent from the
// map is left untouched. Called by materializeClipboardSvg after collision-renaming re-uploads.
export function rewriteEigenMediaRefs(svg: string, renames: Map<string, string>): string {
    if (renames.size === 0) return svg;
    const tokens = new Map<string, string>();
    for (const [from, to] of renames) tokens.set(eigenMediaHref(from), eigenMediaHref(to));
    return svg.replace(REF_SCAN, (token) => tokens.get(token) ?? token);
}

// Drop the `href` attribute of every `<image>` referencing one of `names`, so the element renders as
// nothing (sceneToSvg's null-media contract). Called by materializeClipboardSvg for images
// whose re-upload failed — skip-on-failure, never abort the paste.
export function stripEigenMediaRefs(svg: string, names: Iterable<string>): string {
    let out = svg;
    for (const name of names) {
        out = out.split(` href="${eigenMediaHref(name)}"`).join('');
    }
    return out;
}
