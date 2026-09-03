import DOMPurify from 'isomorphic-dompurify';

type SanitizeConfig = Parameters<typeof DOMPurify.sanitize>[1];

// DOMPurify's own config plus the exact non-data: URLs this body keeps. Exports embed every resource
// as a data: URI and pass none; a preview body embeds the `/file/<id>/preview` URLs the main thread
// resolved, so it passes exactly those — an exact-string set, never a host or prefix rule.
type SanitizeOptions = SanitizeConfig & { allowedRefs?: ReadonlySet<string> };

// Minimal structural view of the jsdom element passed to DOMPurify hooks.
type AttrNode = {
    tagName?: string;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
};

const CSS_URL = /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;
const NO_REFS: ReadonlySet<string> = new Set();

// Fetched without a click, on any element DOMPurify keeps: `src` (img, video, audio, source,
// input type=image), `poster`, and the legacy `background`. `srcset` is handled separately.
const REF_ATTRS = ['src', 'poster', 'background'];

const isAllowedRef = (value: string, allowed: ReadonlySet<string>): boolean =>
    /^\s*data:/i.test(value) || allowed.has(value);

function restrictCssUrls(css: string, allowed: ReadonlySet<string>): string {
    return css.replace(CSS_URL, (match, _quote, url: string) => (isAllowedRef(url, allowed) ? match : 'url()'));
}

// Every export resource is embedded as a data: URI (fonts + images) and every preview resource is one
// of the prepared media URLs, so any other CSS url() or fetching attribute is attacker-injected via
// schemaless slide/sheet/vector CRDT strings. WeasyPrint fetches those server-side when rendering the
// PDF (SSRF from the API host), and a preview body is injected as live DOM in the drive hero (a beacon
// fired at every viewer). Its CLI can't restrict protocols and DOMPurify keeps url()/src by default,
// so restrict here. <a href> is left alone — link targets aren't fetched during render, and
// sheets/docs carry legitimate http(s) hyperlinks.
function restrictToDataRefs(node: AttrNode, allowed: ReadonlySet<string>): void {
    const style = node.getAttribute('style');
    if (style != null) {
        // A CSS escape spells the same token invisibly to a regex (`\75 rl(…)` is
        // `url(…)` to the parser), so drop backslashes before scanning. Generated
        // export CSS never contains one.
        const scanned = style.replace(/\\/g, '');
        const stripped = scanned.includes('url(') ? restrictCssUrls(scanned, allowed) : scanned;
        if (stripped !== style) node.setAttribute('style', stripped);
    }
    // A srcset candidate list separates candidates with the same comma a data: URI contains, so it is
    // dropped rather than parsed — no renderer here emits one.
    node.removeAttribute('srcset');
    for (const attr of REF_ATTRS) {
        const value = node.getAttribute(attr);
        if (value != null && !isAllowedRef(value, allowed)) node.removeAttribute(attr);
    }
    // SVG <image>/<use> reference through href (and legacy xlink:href), which DOMPurify
    // keeps by default and WeasyPrint fetches server-side — the same SSRF as <img src>,
    // through a different attribute.
    for (const attr of ['href', 'xlink:href']) {
        const value = node.getAttribute(attr);
        if (value != null && !isAllowedRef(value, allowed) && node.tagName !== 'A') node.removeAttribute(attr);
    }
}

// Same restriction for CSS text inside <style> elements (the sheets export emits its class
// rules there), plus @import — the string form fetches without any url(), and at-rules can
// only exist in element CSS, never in a declaration-only style attribute.
function restrictStyleTextToDataRefs(node: { textContent: string | null }, allowed: ReadonlySet<string>): void {
    const text = node.textContent;
    if (!text) return;
    // Backslashes go first for the same reason as in style attributes: `@\69 mport` and
    // `\75 rl(` are `@import` and `url(` to a CSS parser but not to these regexes.
    const stripped = restrictCssUrls(text.replace(/\\/g, ''), allowed).replace(/@import\b/gi, '');
    if (stripped !== text) node.textContent = stripped;
}

// Shared sanitizer for assembled export and preview bodies (slides/sheets/docs/vector), used for HTML,
// PDF and live-DOM output. Adds the URL restriction on top of DOMPurify. The hooks are scoped to this
// synchronous call (add → sanitize → remove), so they never leak to other DOMPurify users.
export function sanitizeExportHtml(html: string, options?: SanitizeOptions): string {
    const { allowedRefs = NO_REFS, ...config } = options ?? {};
    DOMPurify.addHook('afterSanitizeAttributes', (node) =>
        restrictToDataRefs(node as unknown as AttrNode, allowedRefs),
    );
    DOMPurify.addHook('uponSanitizeElement', (node, data) => {
        if (data.tagName === 'style') restrictStyleTextToDataRefs(node as { textContent: string | null }, allowedRefs);
    });
    try {
        return DOMPurify.sanitize(html, { FORCE_BODY: true, ...config }) as string;
    } finally {
        DOMPurify.removeHook('afterSanitizeAttributes');
        DOMPurify.removeHook('uponSanitizeElement');
    }
}
