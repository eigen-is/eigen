import { MathError } from './error';

// The element the readers take: the API's Bun-parsed XmlElement as is, or a DOM element through fromDom. Attributes
// are keyed as written, so `m:val` and `val` both answer to `val`.
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

const ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\t': '&#9;',
    '\n': '&#10;',
    '\r': '&#13;',
};

// Text or attribute value: `>` too, so `]]>` never closes anything, and whitespace as references, which an attribute
// would read back as spaces.
export function escapeXml(text: string): string {
    return text.replace(/[&<>"\t\n\r]/g, (char) => ESCAPES[char]);
}
