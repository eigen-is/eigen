import { ApiError } from './errors';
import { CONTENT_TYPES_NS, PACKAGE_RELATIONSHIPS_NS, parseOoxml } from './ooxml';
import { hasXmlName, type XmlElement, XmlError, xmlElements } from './xml';
import { openZip, ZipError, type ZipReader } from './zip';

// The Open Packaging Conventions every OOXML format shares: the package, a part's relationships and the part names they
// resolve to.

export type Relationship = { type: string; target: string; external: boolean };

// '' is the package itself, whose relationships are _rels/.rels.
export function relsPathOf(partPath: string): string {
    const slash = partPath.lastIndexOf('/');
    return `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`;
}

// An internal target is resolved to a part name; an External one is kept as written.
export function relationshipsOf(root: XmlElement | undefined, partPath: string): Map<string, Relationship> {
    const rels = new Map<string, Relationship>();
    for (const rel of root ? xmlElements(root) : []) {
        const id = rel.attributes['Id'];
        if (!hasXmlName(rel, PACKAGE_RELATIONSHIPS_NS, 'Relationship') || !id) continue;
        const target = rel.attributes['Target'] ?? '';
        const external = rel.attributes['TargetMode'] === 'External';
        rels.set(id, {
            type: rel.attributes['Type'] ?? '',
            target: external ? target : resolveTarget(partPath, target),
            external,
        });
    }
    return rels;
}

// By the type's last segment, so a Strict package's relationship types match too.
export function relOfType(rels: ReadonlyMap<string, Relationship>, type: string): string | undefined {
    for (const rel of rels.values()) if (rel.type.endsWith(`/${type}`) && !rel.external) return rel.target;
    return undefined;
}

// A relationship target percent-encodes what a URI reference can't hold; `%` stays, so an encoded href encodes no
// further.
export function uriReference(href: string): string {
    return href.replace(/[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/gu, (character) => encodeURIComponent(character));
}

// An absolute target climbs from the package root, so neither kind keeps a '..' a format's prefix check would miss.
function resolveTarget(base: string, target: string): string {
    const parts = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
    for (const segment of target.split('/')) {
        if (segment === '..') parts.pop();
        else if (segment !== '.' && segment !== '') parts.push(segment);
    }
    return parts.join('/');
}

// A format reads its package only through relationships and [Content_Types].xml, so an entry named outside them is never
// read.
export type OoxmlPackage = {
    zip: ZipReader;
    // Parsed once: every reader of a part shares its tree, or the error it failed with. A missing part is undefined.
    part(path: string): XmlElement | undefined;
    // '' for the package's own.
    relationships(partPath: string): Map<string, Relationship>;
    contentTypeOf(path: string): string | undefined;
};

// One budget for the parts a package parses whole, together, [Content_Types].xml and the relationships parts too, the
// same in every format: a parsed tree costs many times its text (core/xml.ts). The transform process's memory limit is
// the backstop past it. The corpora's most, a package's parts together: a docx's 15.3 MB, an xlsx's 15.5 MB, a pptx's
// 8.0 MB.
export const MAX_PACKAGE_XML_BYTES = 32 * 1024 * 1024;

// A tree costs per element too, so the parts' elements have a budget of their own: 16 MB of empty paragraphs is 2.8
// million elements and 3.5 GB. Counted as '<' in the bytes. The corpora's most: 611,000 tags in a docx.
export const MAX_PACKAGE_XML_TAGS = 1_500_000;

// The format's words for an encrypted package, which name the application that removes the password, and for one past
// the budget.
export type PackageMessages = { passwordProtected: string; tooLarge: string };

// An encrypted package is an OLE compound file holding the package as a stream of this name.
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENCRYPTED_PACKAGE = Buffer.from('EncryptedPackage', 'utf16le');

// Any other OLE file, a .doc or an .xls say, is no zip, which openZip refuses.
export function isEncryptedPackage(bytes: Uint8Array): boolean {
    return (
        OLE_SIGNATURE.every((byte, index) => bytes[index] === byte) && Buffer.from(bytes).includes(ENCRYPTED_PACKAGE)
    );
}

// Each part is charged against the budget before it parses, its declared size before it inflates (a read inflates no
// further, core/zip), its tags before the parse. A part past the budget refuses the whole package.
export function openPackage(bytes: Uint8Array, messages: PackageMessages): OoxmlPackage {
    if (isEncryptedPackage(bytes)) throw new ApiError(400, messages.passwordProtected);
    const zip = openZip(bytes);
    const budget = { bytes: MAX_PACKAGE_XML_BYTES, tags: MAX_PACKAGE_XML_TAGS };
    const parsed = new Map<string, XmlElement | undefined>();
    const failed = new Map<string, unknown>();
    const part = (path: string): XmlElement | undefined => {
        if (parsed.has(path)) return parsed.get(path);
        if (failed.has(path)) throw failed.get(path);
        try {
            const size = zip.entry(path)?.size ?? 0;
            if (size > budget.bytes) throw new ApiError(413, messages.tooLarge);
            const data = zip.read(path);
            const tags = data ? tagsIn(data) : 0;
            if (tags > budget.tags) throw new ApiError(413, messages.tooLarge);
            budget.bytes -= size;
            budget.tags -= tags;
            const root = (data && parseOoxml(data)) ?? undefined;
            parsed.set(path, root);
            return root;
        } catch (error) {
            failed.set(path, error);
            throw error;
        }
    };
    const defaults = new Map<string, string>();
    const overrides = new Map<string, string>();
    const types = part('[Content_Types].xml');
    for (const entry of types ? xmlElements(types) : []) {
        const contentType = (entry.attributes['ContentType'] ?? '').toLowerCase();
        if (hasXmlName(entry, CONTENT_TYPES_NS, 'Default'))
            defaults.set((entry.attributes['Extension'] ?? '').toLowerCase(), contentType);
        if (hasXmlName(entry, CONTENT_TYPES_NS, 'Override'))
            overrides.set((entry.attributes['PartName'] ?? '').replace(/^\//, ''), contentType);
    }
    return {
        zip,
        part,
        relationships: (partPath) => relationshipsOf(part(relsPathOf(partPath)), partPath),
        contentTypeOf: (path) =>
            overrides.get(path) ?? defaults.get(path.slice(path.lastIndexOf('.') + 1).toLowerCase()),
    };
}

const LESS_THAN = 0x3c;

function tagsIn(data: Uint8Array): number {
    let tags = 0;
    for (let at = data.indexOf(LESS_THAN); at >= 0; at = data.indexOf(LESS_THAN, at + 1)) tags++;
    return tags;
}

// A damaged optional part, its XML or its entry, costs what it adds, not the document; the budget or an out-of-memory
// still refuses the document.
export function optional<T>(read: () => T): T | undefined {
    try {
        return read();
    } catch (error) {
        if (error instanceof XmlError || (error instanceof ZipError && error.status === 400)) return undefined;
        throw error;
    }
}
