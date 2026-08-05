import DOMPurify from 'isomorphic-dompurify';

type SanitizeConfig = Parameters<typeof DOMPurify.sanitize>[1];

// Minimal structural view of the jsdom element passed to DOMPurify hooks.
type AttrNode = {
    tagName?: string;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
};

const NON_DATA_URL = /url\(\s*(['"]?)\s*(?!data:)[^)'"]*\1\s*\)/gi;
const isDataUri = (value: string): boolean => /^\s*data:/i.test(value);

// Every export resource is embedded as a data: URI (fonts + images), so any CSS url() or <img src>
// pointing elsewhere is attacker-injected via schemaless slide/sheet CRDT strings. WeasyPrint fetches
// those server-side when rendering the PDF (SSRF from the API host). Its CLI can't restrict protocols
// and DOMPurify keeps url()/src by default, so restrict to data: here. <a href> is left alone — link
// targets aren't fetched during render, and sheets/docs carry legitimate http(s) hyperlinks.
function restrictToDataRefs(node: AttrNode): void {
    const style = node.getAttribute('style');
    if (style != null) {
        // A CSS escape spells the same token invisibly to a regex (`\75 rl(…)` is
        // `url(…)` to the parser), so drop backslashes before scanning. Generated
        // export CSS never contains one.
        const scanned = style.replace(/\\/g, '');
        const stripped = scanned.includes('url(') ? scanned.replace(NON_DATA_URL, 'url()') : scanned;
        if (stripped !== style) node.setAttribute('style', stripped);
    }
    if (node.tagName === 'IMG') {
        const src = node.getAttribute('src');
        if (src && !isDataUri(src)) node.removeAttribute('src');
    }
    // SVG <image>/<use> reference through href (and legacy xlink:href), which DOMPurify
    // keeps by default and WeasyPrint fetches server-side — the same SSRF as <img src>,
    // through a different attribute.
    for (const attr of ['href', 'xlink:href']) {
        const value = node.getAttribute(attr);
        if (value != null && !isDataUri(value) && node.tagName !== 'A') node.removeAttribute(attr);
    }
}

// Same restriction for CSS text inside <style> elements (the sheets export emits its class
// rules there), plus @import — the string form fetches without any url(), and at-rules can
// only exist in element CSS, never in a declaration-only style attribute.
function restrictStyleTextToDataRefs(node: { textContent: string | null }): void {
    const text = node.textContent;
    if (!text) return;
    // Backslashes go first for the same reason as in style attributes: `@\69 mport` and
    // `\75 rl(` are `@import` and `url(` to a CSS parser but not to these regexes.
    const stripped = text
        .replace(/\\/g, '')
        .replace(NON_DATA_URL, 'url()')
        .replace(/@import\b/gi, '');
    if (stripped !== text) node.textContent = stripped;
}

// Shared sanitizer for assembled export bodies (slides/sheets/docs), used for both HTML and PDF
// output. Adds the data-only URL restriction on top of DOMPurify. The hooks are scoped to this
// synchronous call (add → sanitize → remove), so they never leak to other DOMPurify users.
export function sanitizeExportHtml(html: string, options?: SanitizeConfig): string {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => restrictToDataRefs(node as unknown as AttrNode));
    DOMPurify.addHook('uponSanitizeElement', (node, data) => {
        if (data.tagName === 'style') restrictStyleTextToDataRefs(node as { textContent: string | null });
    });
    try {
        return DOMPurify.sanitize(html, { FORCE_BODY: true, ...options }) as string;
    } finally {
        DOMPurify.removeHook('afterSanitizeAttributes');
        DOMPurify.removeHook('uponSanitizeElement');
    }
}
