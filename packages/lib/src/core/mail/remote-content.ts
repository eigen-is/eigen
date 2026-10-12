// What in a message fetches from elsewhere as it renders, so a sender learns it was opened. React-free and
// DOM-free at module level: the API's `.eml` preview applies the same rules inside DOMPurify, and only
// stripRemoteContent, the mail reader's, needs the browser's DOMParser.

// Fetched as the message renders, on any element a sanitizer keeps. An <a> keeps its href: a click fetches it.
export const FETCHING_ATTRS = ['src', 'srcset', 'poster', 'background', 'href', 'xlink:href', 'data'];

// Function tokens that fetch without a url(). eml-preview refuses a backslash on top; the export sanitizer, attr().
export const CSS_FETCH_FUNCTIONS = /@import|image-set|image\(|cross-fade|element\(/i;

const SVG_NS = 'http://www.w3.org/2000/svg';
// The one reference a message may keep: a raster image the parser inlined. An SVG or HTML data: URI is a
// document tree of its own, and only the browser's SVG-as-image rules would stand between it and a fetch.
const RASTER_DATA_URI = String.raw`data:image\/(?:png|jpe?g|gif|webp|avif|bmp)[;,]`;
const INLINE_IMAGE = new RegExp(`^\\s*${RASTER_DATA_URI}`, 'i');
const CSS_REMOTE_URL = new RegExp(`url\\((?!\\s*(?:['"]\\s*)?${RASTER_DATA_URI})`, 'i');

// Defense in depth: a viewer that deleted a color-scheme block as text would rejoin what surrounds it
// (`ur@media (prefers-color-scheme: dark){}l(https://…)`), so the text each deletion would leave is checked too.
const schemeMediaBlock = (scheme: string) =>
    new RegExp(
        String.raw`@media\s*\([^)]*prefers-color-scheme:\s*${scheme}[^)]*\)\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}`,
        'gi',
    );
const SCHEME_MEDIA_BLOCKS = [schemeMediaBlock('dark'), schemeMediaBlock('light')];

// Both refusals read a token, never a pair: a CSS escape spells `url(` invisibly to a regex (`u\72l(`), and
// an unterminated `url(` fetches without ever closing.
function fetchTokens(css: string): boolean {
    return css.includes('\\') || CSS_FETCH_FUNCTIONS.test(css) || CSS_REMOTE_URL.test(css);
}

export function cssFetches(css: string): boolean {
    return fetchTokens(css) || SCHEME_MEDIA_BLOCKS.some((block) => fetchTokens(css.replace(block, '')));
}

// A sheet's top-level statements: a rule or block ends at the `}` that closes it, an at-statement at its `;`.
// Braces in strings and comments can misplace a cut, which is why the kept text is checked again whole.
export function cssStatements(css: string): string[] {
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

// Only the statements that fetch go, so the layout beside them survives; a sheet whose kept text still
// fetches is emptied.
export function restrictSheet(css: string): string {
    const kept = cssStatements(css)
        .filter((statement) => !cssFetches(statement))
        .join('');
    return cssFetches(kept) ? '' : kept;
}

// Removes the element's references in `attrs` that are not an inline raster image, a style that fetches, and on
// SVG, where a presentation attribute is CSS (`fill="url(…)"`), any attribute that fetches. True when it removed one.
export function stripRemoteRefs(el: Element, attrs: readonly string[] = FETCHING_ATTRS): boolean {
    const anchor = el.localName === 'a';
    const svg = el.namespaceURI === SVG_NS;
    let removed = false;
    for (const { name, value } of [...el.attributes]) {
        const css = name === 'style' || svg;
        const ref = attrs.includes(name) && !(anchor && name === 'href');
        // A srcset is a candidate list: an inline first candidate says nothing of the next.
        if ((css && cssFetches(value)) || (ref && (name === 'srcset' || !INLINE_IMAGE.test(value)))) {
            el.removeAttribute(name);
            removed = true;
        }
    }
    return removed;
}

// One strip over an inert parse (DOMParser runs no script and loads nothing); null when it removed nothing.
function stripPass(html: string): string | null {
    // The <body> keeps a leading <style> in the body, where the reader's FORCE_BODY sanitize left it.
    const doc = new DOMParser().parseFromString(`<body>${html}`, 'text/html');
    let removed = false;
    for (const el of doc.body.querySelectorAll('*')) {
        if (stripRemoteRefs(el)) removed = true;
        if (el.localName !== 'style') continue;
        const sheet = el.textContent ?? '';
        const kept = restrictSheet(sheet);
        if (kept !== sheet) {
            el.textContent = kept;
            removed = true;
        }
    }
    return removed ? doc.body.innerHTML : null;
}

const MAX_STRIP_PASSES = 3;

// The mail reader's body before Load images: no remote reference left, and whether one was there. A body with
// nothing to remove comes back as the same string. A serialized tree can parse back to another (mXSS), so the
// strip repeats until a pass removes nothing, and a body that never settles shows nothing.
export function stripRemoteContent(html: string): { html: string; blocked: boolean } {
    let current = html;
    for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
        const next = stripPass(current);
        if (next === null) return { html: current, blocked: pass > 0 };
        current = next;
    }
    return { html: '', blocked: true };
}
