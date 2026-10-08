import { LIGHT_EDITOR_ATTRS, LIGHT_EDITOR_HREF, LIGHT_EDITOR_TAGS } from '@workspace/lib/html';
import type { VectorScene } from '@workspace/lib/vector';
import { stripNonXmlChars } from '@workspace/lib/xml';
import DOMPurify from 'isomorphic-dompurify';
import { JSDOM } from 'jsdom';
import { type ExportMedia, toTransferableText } from '../document/transform/protocol';

type SanitizeConfig = Parameters<typeof DOMPurify.sanitize>[1];

// DOMPurify's own config plus the exact non-data: URLs this body keeps. Exports embed every resource
// as a data: URI and pass none; a preview body embeds the `/file/<id>/preview` URLs the main thread
// resolved, so it passes exactly those — an exact-string set, never a host or prefix rule.
type SanitizeOptions = SanitizeConfig & { allowedRefs?: ReadonlySet<string> };

// Minimal structural view of the jsdom element passed to DOMPurify hooks.
export type AttrNode = {
    tagName?: string;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
};

// CSS whitespace only: a non-breaking space is part of the URL, which then is a relative path.
const CSS_URL = /url\([\t\n\f\r ]*(['"]?)([^)'"]*)\1[\t\n\f\r ]*\)/gi;
const NO_REFS: ReadonlySet<string> = new Set();

// The element hook types its node as a bare Node.
const isElement = (node: Node): node is Element => node.nodeType === 1;

// Fetched without a click, on any element DOMPurify keeps: `src` (img, video, audio, source,
// input type=image), `poster`, and the legacy `background`. `srcset` is handled separately.
const REF_ATTRS = ['src', 'poster', 'background'];

// Only the whitespace a URL parser trims: a leading non-breaking space makes a relative path of the rest.
const isAllowedRef = (value: string, allowed: ReadonlySet<string>): boolean =>
    /^[\t\n\f\r ]*data:/i.test(value) || allowed.has(value);

// A reference into the same document (a gradient, a clip, a <use> glyph) fetches nothing.
const isFragmentRef = (value: string): boolean => /^[\t\n\f\r ]*#\S*[\t\n\f\r ]*$/.test(value);

function restrictCssUrls(css: string, allowed: ReadonlySet<string>): string {
    return css.replace(CSS_URL, (match, _quote, url: string) =>
        isAllowedRef(url, allowed) || isFragmentRef(url) ? match : 'url()',
    );
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
    // through a different attribute. jsdom names an SVG <a> in lowercase, an HTML one in upper.
    if (node.tagName?.toLowerCase() === 'a') return;
    for (const attr of ['href', 'xlink:href']) {
        const value = node.getAttribute(attr);
        if (value != null && !isAllowedRef(value, allowed) && !isFragmentRef(value)) node.removeAttribute(attr);
    }
}

// DOMPurify's default profile drops every <use>; one that draws a glyph from its own document fetches nothing.
function isSameDocumentUse(node: AttrNode): boolean {
    const refs = [node.getAttribute('href'), node.getAttribute('xlink:href')].filter((ref) => ref !== null);
    return refs.length > 0 && refs.every(isFragmentRef);
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
    DOMPurify.addHook('afterSanitizeAttributes', (node) => restrictToDataRefs(node, allowedRefs));
    DOMPurify.addHook('uponSanitizeElement', (node, data) => {
        if (data.tagName === 'style') restrictStyleTextToDataRefs(node, allowedRefs);
        // Decided per element, and only in a profile that admits SVG at all.
        if (data.tagName === 'use' && data.allowedTags['svg']) {
            data.allowedTags['use'] = isElement(node) && isSameDocumentUse(node);
        }
    });
    try {
        return DOMPurify.sanitize(html, { FORCE_BODY: true, ...config }) as string;
    } finally {
        DOMPurify.removeHook('afterSanitizeAttributes');
        DOMPurify.removeHook('uponSanitizeElement');
    }
}

// An .svg file is read by an XML parser, and a rich-text box's HTML is not XML: an unclosed <br>/<img>
// or a named entity is a fatal parse error that renders the whole drawing as nothing. DOMPurify hands
// back HTML serialization, so take its markup through the DOM once more and serialize it as XML. The
// literal xmlns attributes go first — the serializer writes the namespace declarations itself, and a
// second one on the same element is a duplicate attribute. The serializer also writes the control characters the HTML
// parser kept, which no XML reader accepts. Null when there is no <svg> to serialize.
export function toXmlDocument(svg: string): string | null {
    const dom = new JSDOM(svg, { contentType: 'text/html' });
    const root = dom.window.document.querySelector('svg');
    if (!root) return null;
    for (const el of root.querySelectorAll('[xmlns]')) el.removeAttribute('xmlns');
    return stripNonXmlChars(new dom.window.XMLSerializer().serializeToString(root));
}

// An SVG figure's media: the data-only pass every export body gets, written as XML, which a docx part must be and an
// .svg data: URI is read as (DOMPurify writes `&nbsp;` and other HTML-only forms).
export function sanitizeSvgMedia(svg: string): string | null {
    return toXmlDocument(sanitizeExportHtml(svg));
}

// SVG media is the file's own bytes (an uploaded or pasted drawing) and reaches the transform Worker as such. Embedded
// as a data: URI it still reaches WeasyPrint's fetcher (a nested `<image href>` is the same SSRF the assembled document
// closes), so every export arm takes it through sanitizeSvgMedia here, off the event loop. One with no <svg> in it is
// no drawing, and is dropped like a failed preview.
export function sanitizeExportMedia(media: ExportMedia[]): ExportMedia[] {
    return media.flatMap((item) => {
        if (item.contentType !== 'image/svg+xml') return [item];
        const svg = sanitizeSvgMedia(Buffer.from(item.data).toString('utf8'));
        return svg === null ? [] : [{ ...item, data: toTransferableText(svg) }];
    });
}

// A rich-text box's `html` is a schemaless collaborator string, and the canvas mounts it through the
// LightEditor sanitizer — so every renderer of one filters to that same set (@workspace/lib/html), and
// there is a single answer to what a text box can hold. DOMPurify's own profile is far wider: a <table>,
// an <img src="data:…"> or a <style> a peer wrote would be invisible on every live client yet rendered
// in the .svg/.html download, the PDF and the drive hero — and a <style> element styles whatever embeds
// the box rather than the box itself. The assembled document cannot forbid <style> instead: it carries
// the generated @font-face block.
const LIGHT_EDITOR_ONLY: SanitizeConfig = {
    ALLOWED_TAGS: LIGHT_EDITOR_TAGS,
    ALLOWED_ATTR: LIGHT_EDITOR_ATTRS,
    // The scheme rule exists for `href`; `target` and `rel` are not URLs, so they have to opt out of it
    // or DOMPurify tests `_blank` against it and drops the new-tab pair the canvas forces onto a link.
    ALLOWED_URI_REGEXP: LIGHT_EDITOR_HREF,
    ADD_URI_SAFE_ATTR: ['target', 'rel'],
};

// Every canvas scene element that carries an `html` body, with that body filtered: the LightEditor set
// plus the shared restriction to data: refs, so nothing a collaborator wrote in it can fetch from
// anywhere. Every renderer of an untrusted scene — both previews, the deck export, the drawing export —
// reads the scene through here first, then sanitizes its own assembled output.
export function sanitizeSceneHtml(scene: VectorScene): VectorScene {
    return {
        ...scene,
        elements: scene.elements.map((el) =>
            'html' in el ? { ...el, html: sanitizeExportHtml(el.html, LIGHT_EDITOR_ONLY) } : el,
        ),
    };
}
