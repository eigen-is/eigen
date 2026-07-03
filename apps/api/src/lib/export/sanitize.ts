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
    if (style?.includes('url(')) {
        const stripped = style.replace(NON_DATA_URL, 'url()');
        if (stripped !== style) node.setAttribute('style', stripped);
    }
    if (node.tagName === 'IMG') {
        const src = node.getAttribute('src');
        if (src && !isDataUri(src)) node.removeAttribute('src');
    }
}

// Shared sanitizer for assembled export bodies (slides/sheets/docs), used for both HTML and PDF
// output. Adds the data-only URL restriction on top of DOMPurify. The hook is scoped to this
// synchronous call (add → sanitize → remove), so it never leaks to other DOMPurify users.
export function sanitizeExportHtml(html: string, options?: SanitizeConfig): string {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => restrictToDataRefs(node as unknown as AttrNode));
    try {
        return DOMPurify.sanitize(html, { FORCE_BODY: true, ...options }) as string;
    } finally {
        DOMPurify.removeHook('afterSanitizeAttributes');
    }
}
