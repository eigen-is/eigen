import { XML } from 'bun';
import { ApiError } from './errors';

// Every XML read goes through Bun's tree shape, which keeps document order; the compact shape groups same-named
// siblings and loses where text sat. Bun reports names as written, so the namespace resolution is ours.

export type XmlElement = {
    name: string;
    ns: string;
    local: string;
    // As written: `xmlns` declarations included, prefixed names unresolved (xmlAttr resolves them).
    attributes: Record<string, string>;
    children: XmlContent[];
    // Prefix → namespace URI in scope here; '' is the default namespace.
    scope: ReadonlyMap<string, string>;
};

export type XmlContent = string | XmlElement | XML.Comment | XML.ProcessingInstruction;

// Every way parseXml refuses input (malformed, a DOCTYPE, too deep, an unbound prefix) is this one 400.
export class XmlError extends ApiError {
    constructor(message: string, options?: ErrorOptions) {
        super(400, message, options);
    }
}

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const ROOT_SCOPE: ReadonlyMap<string, string> = new Map([['xml', XML_NAMESPACE]]);

// Blank input is null rather than an error: an empty PROPFIND means allprop, an empty PROPPATCH does nothing.
export function parseXml(input: string | Uint8Array): XmlElement | null {
    const prolog =
        typeof input === 'string' ? scanProlog(input, input.charCodeAt(0) === 0xfeff ? 1 : 0, true) : scanBytes(input);
    if (prolog === 'blank') return null;
    try {
        return resolve(XML.parse(input, { compact: false }), ROOT_SCOPE);
    } catch (error) {
        if (error instanceof SyntaxError || error instanceof RangeError) {
            throw new XmlError('Malformed XML', { cause: error });
        }
        throw error;
    }
}

// Bun caps entity expansion but not ATTLIST defaults, which it applies to every element (1 MiB of body costs
// seconds and gigabytes), and an ATTLIST can also inject `xmlns`. Bun has no switch for either, so a DOCTYPE is
// refused before Bun sees it. Only a prolog read the same way Bun reads it passes: whitespace, PIs, comments,
// then the root; anything else is an error Bun would raise anyway. `undefined` asks for more of the prolog.
function scanProlog(text: string, from: number, complete: boolean): 'blank' | 'root' | undefined {
    let i = from;
    let markup = false;
    while (true) {
        while (i < text.length && ' \t\r\n'.includes(text[i])) i++;
        if (text.length - i < 4 && !complete) return undefined;
        if (i === text.length) return markup ? 'root' : 'blank';
        const [open, close] = text.startsWith('<?', i)
            ? ['<?', '?>']
            : text.startsWith('<!--', i)
              ? ['<!--', '-->']
              : [];
        if (open && close) {
            // From past the opener: `<!-->` opens a comment, it doesn't close one.
            const end = text.indexOf(close, i + open.length);
            if (end < 0) return complete ? 'root' : undefined;
            i = end + close.length;
            markup = true;
            continue;
        }
        if (text.startsWith('<!', i)) throw new XmlError('DOCTYPE is not allowed');
        if (text[i] === '<') return 'root';
        throw new XmlError('Malformed XML');
    }
}

// XML 1.0 Appendix F narrowed to what Bun reads: a BOM, UTF-16 by its first `<` (Bun takes BOM-less UTF-16 when
// it declares its encoding), else UTF-8 or ISO-8859-1, whose markup is the same ASCII bytes. Only the prolog is
// decoded, a growing slice at a time; Bun decodes the body itself.
function scanBytes(bytes: Uint8Array): 'blank' | 'root' {
    let encoding = 'latin1';
    let start = 0;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) [encoding, start] = ['utf-16le', 2];
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) [encoding, start] = ['utf-16be', 2];
    else if (bytes[0] === 0x3c && bytes[1] === 0x00) encoding = 'utf-16le';
    else if (bytes[0] === 0x00 && bytes[1] === 0x3c) encoding = 'utf-16be';
    else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
    const decoder = new TextDecoder(encoding, { ignoreBOM: true });
    for (let size = 4096; ; size *= 2) {
        const complete = start + size >= bytes.length;
        const prolog = scanProlog(decoder.decode(bytes.subarray(start, start + size)), 0, complete);
        if (prolog) return prolog;
    }
}

function resolve(node: XML.Node, parentScope: ReadonlyMap<string, string>): XmlElement {
    let own: Map<string, string> | undefined;
    for (const [attribute, uri] of Object.entries(node.attributes)) {
        if (attribute !== 'xmlns' && !attribute.startsWith('xmlns:')) continue;
        const prefix = attribute === 'xmlns' ? '' : attribute.slice('xmlns:'.length);
        if (attribute !== 'xmlns' && (prefix === '' || prefix.includes(':') || uri === '')) {
            throw new XmlError(`Invalid namespace declaration: ${attribute}`);
        }
        own ??= new Map(parentScope);
        own.set(prefix, uri);
    }
    const scope = own ?? parentScope;
    for (const attribute of Object.keys(node.attributes)) {
        if (attribute !== 'xmlns' && !attribute.startsWith('xmlns:')) qualify(attribute, scope, false);
    }
    return {
        name: node.name,
        ...qualify(node.name, scope, true),
        attributes: node.attributes,
        children: node.children.map((child) =>
            typeof child === 'object' && 'name' in child ? resolve(child, scope) : child,
        ),
        scope,
    };
}

// The default namespace applies to elements only (Namespaces in XML § 6.2).
function qualify(name: string, scope: ReadonlyMap<string, string>, isElement: boolean): { ns: string; local: string } {
    const colon = name.indexOf(':');
    if (colon < 0) return { ns: isElement ? (scope.get('') ?? '') : '', local: name };
    const prefix = name.slice(0, colon);
    const local = name.slice(colon + 1);
    if (prefix === '' || local === '' || local.includes(':')) throw new XmlError(`Invalid name: ${name}`);
    const ns = scope.get(prefix);
    if (ns === undefined) throw new XmlError(`Unbound namespace prefix: ${prefix}`);
    return { ns, local };
}

const isXmlElement = (content: XmlContent): content is XmlElement => typeof content === 'object' && 'name' in content;

export function xmlElements(element: XmlElement): XmlElement[] {
    return element.children.filter(isXmlElement);
}

export function xmlChildren(element: XmlElement, ns: string, local: string): XmlElement[] {
    return xmlElements(element).filter((child) => child.ns === ns && child.local === local);
}

export function xmlChild(element: XmlElement, ns: string, local: string): XmlElement | undefined {
    return xmlElements(element).find((child) => child.ns === ns && child.local === local);
}

// As written: trimming is the caller's call.
export function xmlText(element: XmlElement): string {
    return element.children.filter((child) => typeof child === 'string').join('');
}

export function xmlAttr(element: XmlElement, ns: string, local: string): string | undefined {
    for (const [name, value] of Object.entries(element.attributes)) {
        if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
        const qualified = qualify(name, element.scope, false);
        if (qualified.ns === ns && qualified.local === local) return value;
    }
    return undefined;
}

// Client XML kept as XML (a LOCK owner, a dead property's value). Each child element declares every namespace in
// scope, so a prefix bound on an ancestor stays bound once the fragment stands alone; `xml` is bound everywhere.
export function serializeXmlChildren(element: XmlElement): string {
    const children = element.children.map((child) => {
        if (!isXmlElement(child)) return child;
        const declarations: Record<string, string> = {};
        for (const [prefix, uri] of child.scope) {
            if (prefix !== 'xml') declarations[prefix === '' ? 'xmlns' : `xmlns:${prefix}`] = uri;
        }
        return { name: child.name, attributes: { ...declarations, ...child.attributes }, children: child.children };
    });
    // One wrapper so Bun escapes the text children too; its tags come off again.
    const wrapped = XML.stringify({ name: 'x', children });
    return wrapped === '<x/>' ? '' : wrapped.slice('<x>'.length, -'</x>'.length);
}
