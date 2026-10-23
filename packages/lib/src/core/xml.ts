// Not escapeHtml from ./html: XML's five predefined entities include `&apos;`, where HTML wants `&#39;`.

// XML 1.0 § 2.2 Char, negated. The u flag reads a lone surrogate as one code point outside every range, so it
// goes, while a valid pair is one code point above U+FFFF and stays.
const NOT_XML_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

const ENTITY: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
    '\t': '&#9;',
    '\n': '&#10;',
    '\r': '&#13;',
};

export function stripNonXmlChars(value: string): string {
    return value.replace(NOT_XML_CHAR, '');
}

function xmlEscape(value: string, special: RegExp): string {
    return stripNonXmlChars(value).replace(special, (ch) => ENTITY[ch]);
}

// Text or attribute: tab, LF and CR become references, since an attribute reads them back as spaces.
export function escapeXml(value: string): string {
    return xmlEscape(value, /[&<>"'\t\n\r]/g);
}

// Element text whose raw line breaks are the payload (CalDAV calendar-data, CardDAV address-data); never an attribute.
export function escapeXmlText(value: string): string {
    return xmlEscape(value, /[&<>"']/g);
}

// Splice a block right after the root `<svg …>` open tag (every svg font injector uses this).
// Anchoring on the tag — not the document's first `>` — keeps an XML prolog, DOCTYPE, or comment
// ahead of the root intact (an uploaded .svg may carry one; splicing before the root breaks it).
// No open tag → the svg is returned untouched.
export function spliceAfterSvgOpenTag(svg: string, block: string): string {
    const start = svg.search(/<svg[\s>]/);
    if (start === -1) return svg;
    const end = svg.indexOf('>', start);
    if (end === -1) return svg;
    return svg.slice(0, end + 1) + block + svg.slice(end + 1);
}
