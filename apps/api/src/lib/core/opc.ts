import { ApiError, isOutOfMemory } from './errors';
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

function resolveTarget(base: string, target: string): string {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/').slice(0, -1);
    for (const segment of target.split('/')) {
        if (segment === '..') parts.pop();
        else if (segment !== '.' && segment !== '') parts.push(segment);
    }
    return parts.join('/');
}

// A format reads its package only through relationships and [Content_Types].xml, so an entry named outside them is never
// read. What a parsed part costs is the transform process's to bound.
export type OoxmlPackage = {
    zip: ZipReader;
    // Parsed once: every reader of a part shares its tree, or the error it failed with. A missing part is undefined.
    part(path: string): XmlElement | undefined;
    // '' for the package's own.
    relationships(partPath: string): Map<string, Relationship>;
    contentTypeOf(path: string): string | undefined;
};

// An encrypted package is an OLE compound file holding the package as a stream of this name.
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENCRYPTED_PACKAGE = Buffer.from('EncryptedPackage', 'utf16le');

// Any other OLE file, a .doc or an .xls say, is no zip, which openZip refuses.
export function isEncryptedPackage(bytes: Uint8Array): boolean {
    return (
        OLE_SIGNATURE.every((byte, index) => bytes[index] === byte) && Buffer.from(bytes).includes(ENCRYPTED_PACKAGE)
    );
}

// `passwordProtected` is the format's 400 for an encrypted package, which names the application that removes it.
export function openPackage(bytes: Uint8Array, passwordProtected: string): OoxmlPackage {
    if (isEncryptedPackage(bytes)) throw new ApiError(400, passwordProtected);
    const zip = openZip(bytes);
    const parsed = new Map<string, XmlElement | undefined>();
    const failed = new Map<string, unknown>();
    const part = (path: string): XmlElement | undefined => {
        if (parsed.has(path)) return parsed.get(path);
        if (failed.has(path)) throw failed.get(path);
        try {
            const data = zip.read(path);
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

// A damaged optional part, its XML or its entry, costs what it adds, not the document; a cap still refuses it.
export function optional<T>(read: () => T): T | undefined {
    try {
        return read();
    } catch (error) {
        if (error instanceof XmlError || (error instanceof ZipError && error.status === 400)) return undefined;
        throw error;
    }
}

// The zip's and the XML's messages speak of archives and markup; the user uploaded a document or a spreadsheet, so a
// refusal is told in the format's `messages`. An out-of-memory passes as it is: the transform process answers it for
// every format.
export function importError(error: unknown, messages: { tooLarge: string; invalid: string }): Error {
    if (isOutOfMemory(error)) return error;
    if (error instanceof ZipError)
        return new ApiError(error.status, error.status === 413 ? messages.tooLarge : messages.invalid, {
            cause: error,
        });
    if (error instanceof XmlError) return new ApiError(400, messages.invalid, { cause: error });
    if (error instanceof ApiError) return error;
    // A stack the file outgrew; any other RangeError is the reader's slip.
    if (error instanceof RangeError && /call stack/i.test(error.message))
        return new ApiError(413, messages.tooLarge, { cause: error });
    // A file the reader slips on is refused as one it can't read; the slip is a bug, and its cause stays in the transform's log.
    console.warn('[import] the reader failed:', error instanceof Error ? (error.stack ?? error.message) : error);
    return new ApiError(400, messages.invalid, { cause: error });
}
