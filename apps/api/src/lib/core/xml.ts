import { XML } from 'bun';
import { ApiError } from './errors';

// Every XML read goes through Bun's tree shape, which keeps document order; the compact shape groups same-named
// siblings and loses where text sat. Bun reports names as written, so the namespace resolution is ours.

export type XmlElement = {
    name: string;
    ns: string;
    local: string;
    // As written: `xmlns` declarations included, prefixed names unresolved.
    attributes: Record<string, string>;
    // Each prefixed attribute's namespace, by its name as written; declarations aren't in it.
    attributeNs: Readonly<Record<string, string>>;
    children: XmlContent[];
};

export type XmlContent = string | XmlElement | XML.Comment | XML.ProcessingInstruction;

// Every way parseXml refuses input (malformed, a DOCTYPE, too deep, a namespace rule broken) is this one 400, and so
// is serializeXmlChildren's one refusal.
export class XmlError extends ApiError {
    constructor(message: string, options?: ErrorOptions) {
        super(400, message, options);
    }
}

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

// Shared by every element without a prefixed attribute: an object each costs a 1 MiB body of small elements 16 MB.
const NO_ATTRIBUTE_NS: Readonly<Record<string, string>> = Object.freeze({});

// Blank input is null rather than an error: an empty PROPFIND means allprop, an empty PROPPATCH does nothing.
export function parseXml(input: string | Uint8Array): XmlElement | null {
    const prolog =
        typeof input === 'string' ? scanProlog(input, input.charCodeAt(0) === 0xfeff ? 1 : 0, true) : scanBytes(input);
    if (prolog === 'blank') return null;
    try {
        return resolve(XML.parse(input, { compact: false }));
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

// Depth first on an explicit stack: recursion runs out below 2x Bun's deepest nesting, main thread and Worker alike.
// One binding map serves the whole walk, each element's declarations undone on its way out, so a body costs its
// declarations once rather than every binding in scope per declaring element. Undone by setting, never deleting: a
// delete costs JSC's Map its size.
function resolve(root: XML.Node): XmlElement {
    const bindings = new Map<string, string | undefined>([['xml', XML_NAMESPACE]]);
    const open: { content: XML.Node['children']; next: number; element: XmlElement; shadowed: [string, string?][] }[] =
        [];
    const enter = (node: XML.Node): XmlElement => {
        const shadowed: [string, string?][] = [];
        for (const [attribute, uri] of Object.entries(node.attributes)) {
            const prefix = declaredPrefix(attribute);
            if (prefix === undefined) continue;
            // Namespaces in XML § 3: `xmlns` is never declared, `xml` only to its own namespace, and neither
            // namespace goes to another prefix.
            if (
                (attribute !== 'xmlns' && (prefix === '' || prefix.includes(':') || uri === '')) ||
                prefix === 'xmlns' ||
                (prefix === 'xml') !== (uri === XML_NAMESPACE) ||
                uri === XMLNS_NAMESPACE
            ) {
                throw new XmlError(`Invalid namespace declaration: ${attribute}`);
            }
            shadowed.push([prefix, bindings.get(prefix)]);
            bindings.set(prefix, uri);
        }
        let attributeNs: Record<string, string> | undefined;
        let expanded: Set<string> | undefined;
        for (const attribute of Object.keys(node.attributes)) {
            if (declaredPrefix(attribute) !== undefined || !attribute.includes(':')) continue;
            const { ns, local } = qualify(attribute, bindings, false);
            // A local name holds no space, so the key is unambiguous (§ 6.3: no two attributes share an expanded name).
            const key = `${local} ${ns}`;
            if (expanded?.has(key)) throw new XmlError(`Duplicate attribute: ${attribute}`);
            (expanded ??= new Set()).add(key);
            (attributeNs ??= {})[attribute] = ns;
        }
        const content = node.children;
        // Sized up front: a pushed array keeps its growth slack, which a long child list makes megabytes.
        const children = new Array<XmlContent>(content.length);
        const element: XmlElement = {
            name: node.name,
            ...qualify(node.name, bindings, true),
            attributes: node.attributes,
            attributeNs: attributeNs ?? NO_ATTRIBUTE_NS,
            children,
        };
        open.push({ content, next: 0, element, shadowed });
        return element;
    };
    const element = enter(root);
    while (open.length > 0) {
        const frame = open[open.length - 1];
        if (frame.next < frame.content.length) {
            const index = frame.next++;
            const child = frame.content[index];
            frame.element.children[index] = typeof child === 'object' && 'name' in child ? enter(child) : child;
            continue;
        }
        open.pop();
        for (const [prefix, uri] of frame.shadowed) bindings.set(prefix, uri);
    }
    return element;
}

// '' is the default namespace; undefined means the attribute is no declaration.
function declaredPrefix(attribute: string): string | undefined {
    if (attribute === 'xmlns') return '';
    return attribute.startsWith('xmlns:') ? attribute.slice('xmlns:'.length) : undefined;
}

// The default namespace applies to elements only (Namespaces in XML § 6.2).
function qualify(
    name: string,
    scope: ReadonlyMap<string, string | undefined>,
    isElement: boolean,
): { ns: string; local: string } {
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
    if (local.includes(':')) return undefined;
    if (ns === '') {
        return local === 'xmlns' || !Object.hasOwn(element.attributes, local) ? undefined : element.attributes[local];
    }
    for (const [name, attributeNs] of Object.entries(element.attributeNs)) {
        if (attributeNs === ns && name.endsWith(`:${local}`)) return element.attributes[name];
    }
    return undefined;
}

// A binding is declared again on every child that uses it. Its prefix costs no more than the use, but a long URI used
// by many children multiplies: the URIs the declarations add are capped at a whole DAV body.
const MAX_DECLARED_URI_BYTES = 1_048_576;

// Client XML kept as XML (a LOCK owner, a dead property's value), to stand alone or sit inside any envelope: each
// child element declares the namespaces its subtree takes from outside it, the default one included (`xmlns=""`
// too), so a prefix bound on an ancestor stays bound and an envelope's default doesn't leak in. `xml` is bound
// everywhere.
export function serializeXmlChildren(element: XmlElement): string {
    let declaredUris = 0;
    const children = element.children.map((top) => {
        if (!isXmlElement(top)) return top;
        // Prefixes declared on the path inside the subtree (unset rather than deleted, as in resolve), and the
        // bindings it takes from outside, found on an explicit stack as in resolve.
        const inner = new Map<string, boolean>();
        const outer: Record<string, string> = {};
        const open: { children: XmlContent[]; next: number; own: string[] }[] = [];
        const enter = (node: XmlElement) => {
            const own: string[] = [];
            for (const attribute of Object.keys(node.attributes)) {
                const prefix = declaredPrefix(attribute);
                if (prefix === undefined || inner.get(prefix)) continue;
                own.push(prefix);
                inner.set(prefix, true);
            }
            const uses: [string, string][] = [[prefixOf(node.name), node.ns]];
            for (const [name, ns] of Object.entries(node.attributeNs)) uses.push([prefixOf(name), ns]);
            for (const [prefix, ns] of uses) {
                const declaration = prefix === '' ? 'xmlns' : `xmlns:${prefix}`;
                if (prefix === 'xml' || inner.get(prefix) || Object.hasOwn(outer, declaration)) continue;
                outer[declaration] = ns;
                declaredUris += ns.length;
                if (declaredUris > MAX_DECLARED_URI_BYTES) throw new XmlError('Too many namespace declarations');
            }
            open.push({ children: node.children, next: 0, own });
        };
        enter(top);
        while (open.length > 0) {
            const frame = open[open.length - 1];
            if (frame.next < frame.children.length) {
                const child = frame.children[frame.next++];
                if (isXmlElement(child)) enter(child);
                continue;
            }
            open.pop();
            for (const prefix of frame.own) inner.set(prefix, false);
        }
        // Bun writes only name, attributes and children, so the subtree goes in as it is.
        return { ...top, attributes: { ...outer, ...top.attributes } };
    });
    // One wrapper so Bun escapes the text children too; its tags come off again.
    const wrapped = XML.stringify({ name: 'x', children });
    return wrapped === '<x/>' ? '' : wrapped.slice('<x>'.length, -'</x>'.length);
}

function prefixOf(name: string): string {
    const colon = name.indexOf(':');
    return colon < 0 ? '' : name.slice(0, colon);
}
