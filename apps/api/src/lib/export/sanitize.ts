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

// `url(` as the CSS parser reads it, in any case, unless a data: URI or a same-document fragment follows. A token,
// never a url()/quote pair, so no paren or quote inside the URL ends a match early. CSS whitespace only: a
// non-breaking space is part of the URL, which then is a relative path.
const CSS_URL = /url\((?![\t\n\f\r ]*(?:['"][\t\n\f\r ]*)?(?:data:|#))/gi;
// One of the exact allowed refs as a whole url(); none holds a quote, a paren or whitespace.
const CSS_ALLOWED_URL = /^url\([\t\n\f\r ]*(['"]?)([^'"()\s]*)\1[\t\n\f\r ]*\)/i;
// What fetches without a url(): @import's string form and the image functions that take a string.
const CSS_STRING_FETCHES = /@import|image-set\(|image\(|cross-fade\(|element\(/i;
// An escape can spell `url(` in any attribute a CSS parser reads (`fill="\75 rl(…)"`).
const ESCAPED_FUNCTION = /\\[^(]*\(/;
const NO_REFS: ReadonlySet<string> = new Set();

// The element hook types its node as a bare Node.
const isElement = (node: Node): node is Element => node.nodeType === 1;

// Fetched without a click, on any element DOMPurify keeps: `src` (img, video, audio, source,
// input type=image), `poster`, and the legacy `background`. `srcset` is handled separately.
const REF_ATTRS = ['src', 'poster', 'background'];

// Only the whitespace a URL parser trims: a leading non-breaking space makes a relative path of the rest.
const isAllowedRef = (value: string, allowed: ReadonlySet<string>): boolean =>
    /^[\t\n\f\r ]*data:/i.test(value) || allowed.has(value);

// The elements whose href points into their own document. On another (an image, feImage) WeasyPrint resolves a
// fragment against its base and opens file://<cwd>/; SVG 2 gives clipPath and mask no href. Lowercase, as compared.
const FRAGMENT_REF_TAGS = new Set([
    'use',
    'lineargradient',
    'radialgradient',
    'pattern',
    'filter',
    'textpath',
    'mpath',
]);

// A reference into the same document (a gradient, a clip, a <use> glyph) fetches nothing.
const isFragmentRef = (value: string): boolean => /^[\t\n\f\r ]*#\S*[\t\n\f\r ]*$/.test(value);

// Read as a token, never a pair, as eml-preview.ts reads a message's CSS: a comment after `url(` is no fragment or
// data: URI, so it fails the lookahead.
function urlFetches(text: string, allowed: ReadonlySet<string>): boolean {
    for (const { index } of text.matchAll(CSS_URL)) {
        const ref = CSS_ALLOWED_URL.exec(text.slice(index))?.[2];
        if (!ref || !allowed.has(ref)) return true;
    }
    return false;
}

const cssFetches = (css: string, allowed: ReadonlySet<string>): boolean =>
    CSS_STRING_FETCHES.test(css) || urlFetches(css, allowed);

// A sheet's top-level statements: a rule or block ends at the `}` that closes it, an at-statement at its `;`.
// Braces in strings and comments can misplace a cut, which is why the kept text is checked again whole.
function cssStatements(css: string): string[] {
    const statements: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') depth = Math.max(depth - 1, 0);
        else if (css[i] !== ';') continue;
        if (depth === 0) {
            statements.push(css.slice(start, i + 1));
            start = i + 1;
        }
    }
    statements.push(css.slice(start));
    return statements;
}

// Every export resource is embedded as a data: URI (fonts + images) and every preview resource is one
// of the prepared media URLs, so any other CSS url() or fetching attribute is attacker-injected via
// schemaless slide/sheet/vector CRDT strings. WeasyPrint fetches those server-side when rendering the
// PDF (SSRF from the API host), and a preview body is injected as live DOM in the drive hero (a beacon
// fired at every viewer). Its CLI can't restrict protocols and DOMPurify keeps url()/src by default,
// so restrict here. <a href> is left alone — link targets aren't fetched during render, and
// sheets/docs carry legitimate http(s) hyperlinks.
function restrictToDataRefs(node: Element, allowed: ReadonlySet<string>): void {
    // SVG presentation attributes (fill, filter, mask, marker-*) are CSS too, so every value is scanned for `url(`.
    for (const { name, value } of [...node.attributes]) {
        if (name === 'style') {
            // A CSS escape spells the same token invisibly to a regex (`\75 rl(…)` is `url(…)` to the parser), so
            // backslashes go before the scan. Generated export CSS never contains one.
            const scanned = value.replace(/\\/g, '');
            if (cssFetches(scanned, allowed)) node.removeAttribute(name);
            else if (scanned !== value) node.setAttribute(name, scanned);
        } else if (urlFetches(value, allowed) || ESCAPED_FUNCTION.test(value)) {
            node.removeAttribute(name);
        }
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
    const tag = node.tagName.toLowerCase();
    if (tag === 'a') return;
    const references = FRAGMENT_REF_TAGS.has(tag);
    for (const attr of ['href', 'xlink:href']) {
        const value = node.getAttribute(attr);
        if (value != null && !isAllowedRef(value, allowed) && !(references && isFragmentRef(value))) {
            node.removeAttribute(attr);
        }
    }
}

// DOMPurify's default profile drops every <use>; one that draws a glyph from its own document fetches nothing.
function isSameDocumentUse(node: AttrNode): boolean {
    const refs = [node.getAttribute('href'), node.getAttribute('xlink:href')].filter((ref) => ref !== null);
    return refs.length > 0 && refs.every(isFragmentRef);
}

// Same restriction for CSS text inside <style> elements (the sheets export emits its class rules there). Only the
// statements that fetch go, so the rules beside them survive; a sheet whose kept text still fetches is emptied.
function restrictStyleTextToDataRefs(node: { textContent: string | null }, allowed: ReadonlySet<string>): void {
    const text = node.textContent;
    if (!text) return;
    // Backslashes go first for the same reason as in style attributes: `@\69 mport` and `\75 rl(` are `@import` and
    // `url(` to a CSS parser but not to the scan.
    const kept = cssStatements(text.replace(/\\/g, ''))
        .filter((statement) => !cssFetches(statement, allowed))
        .join('');
    const stripped = cssFetches(kept, allowed) ? '' : kept;
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

// A <use> draws its target once per reference, so nested ones multiply (6 levels of 10 is a million copies). One stays
// only when every target it names exists and holds no <use>, the one level matplotlib's glyphs need, which also ends
// every cycle. A `%` goes too: a reader may decode it to another id than the one looked up here.
function dropNestedUses(root: Element): void {
    const ids = new Set([...root.querySelectorAll('[id]')].map((el) => el.id));
    const nesting = new Set<string>();
    for (const use of root.querySelectorAll('use')) {
        for (let el: Element | null = use; el; el = el.parentElement) if (el.id) nesting.add(el.id);
    }
    for (const use of root.querySelectorAll('use')) {
        const targets = [use.getAttribute('href'), use.getAttribute('xlink:href')]
            .filter((ref) => ref !== null)
            .map((ref) => ref.trim().slice(1));
        if (targets.some((id) => id.includes('%') || !ids.has(id) || nesting.has(id))) use.remove();
    }
}

// An .svg is read as XML, where DOMPurify's HTML (an unclosed <br>, an &nbsp;) blanks the drawing. Empty with no <svg>.
export function toXmlDocument(svg: string): string {
    const dom = new JSDOM(svg, { contentType: 'text/html' });
    const root = dom.window.document.querySelector('svg');
    if (!root) return '';
    dropNestedUses(root);
    // The serializer declares the namespaces itself, and a second xmlns is a duplicate attribute.
    for (const el of root.querySelectorAll('[xmlns]')) el.removeAttribute('xmlns');
    return stripNonXmlChars(new dom.window.XMLSerializer().serializeToString(root));
}

// SVG media is the file's own bytes (an uploaded or pasted drawing) and reaches the transform Worker as such. Embedded
// as a data: URI it still reaches WeasyPrint's fetcher (a nested `<image href>` is the same SSRF the assembled document
// closes), so every export arm takes it through the data-only pass here, off the event loop, written as XML, which a
// docx part must be and an .svg data: URI is read as. One with no <svg> in it is no drawing, and is dropped like a
// failed preview.
export function sanitizeExportMedia(media: ExportMedia[]): ExportMedia[] {
    return media.flatMap((item) => {
        if (item.contentType !== 'image/svg+xml') return [item];
        const svg = toXmlDocument(sanitizeExportHtml(Buffer.from(item.data).toString('utf8')));
        return svg ? [{ ...item, data: toTransferableText(svg) }] : [];
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
