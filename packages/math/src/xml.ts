// The XML helpers every reader and writer shares. A reader takes MathXmlElement, an element its caller parsed, never
// a string, so the package holds no XML parser. Around it sit small tools, such as reading an attribute without its
// prefix, refusing a character XML can't hold and escaping what a writer writes.

import { MathError } from './error';

// Bun's XmlElement as is, or a DOM element through fromDom. Attributes keep their prefix: `m:val` answers to `val`.
export type MathXmlElement = {
    ns: string;
    local: string;
    attributes: Readonly<Record<string, string>>;
    children: readonly (string | object)[];
};

// Bun's tree also holds comment and processing-instruction objects, which have no `local`.
function isElement(child: string | object): child is MathXmlElement {
    return typeof child === 'object' && 'local' in child;
}

export function elementsOf(element: MathXmlElement): MathXmlElement[] {
    return element.children.filter(isElement);
}

export function textOf(element: MathXmlElement): string {
    return element.children.filter((child) => typeof child === 'string').join('');
}

export function attribute(element: MathXmlElement, local: string): string | undefined {
    for (const [name, value] of Object.entries(element.attributes)) {
        if (name === local || name.endsWith(`:${local}`)) return value;
    }
    return undefined;
}

// XML 1.0 § 2.2 Char, negated: the package throws on one, where lib's stripNonXmlChars strips it.
export const NOT_XML = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

export function checkedXml(text: string): string {
    if (NOT_XML.test(text)) throw new MathError('An equation holds a character XML cannot hold');
    return text;
}

// A loop, not a regex: an anchored end pattern backtracks through every interior run, in quadratic time.
export function replaceEdges(text: string, edge: ReadonlySet<string>, by: string): string {
    let start = 0;
    let end = text.length;
    while (start < end && edge.has(text[start])) start++;
    while (end > start && edge.has(text[end - 1])) end--;
    return by.repeat(start) + text.slice(start, end) + by.repeat(text.length - end);
}

const XML_SPACE: ReadonlySet<string> = new Set(' \t\n\r');

export function trimXmlSpace(text: string): string {
    return replaceEdges(text, XML_SPACE, '');
}

const ESCAPES: Readonly<Record<string, string>> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\t': '&#9;',
    '\n': '&#10;',
    '\r': '&#13;',
};
const ESCAPED = new RegExp(`[${Object.keys(ESCAPES).join('')}]`, 'g');

// For text and attributes: `>` so `]]>` closes nothing, whitespace as references an attribute won't read as spaces.
export function escapeXml(text: string): string {
    return text.replace(ESCAPED, (char) => ESCAPES[char]);
}
