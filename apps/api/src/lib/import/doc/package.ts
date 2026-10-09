import { ApiError } from '../../core/errors';
import { CONTENT_TYPES_NS, MC_NS, PACKAGE_RELATIONSHIPS_NS, toTransitional, W_NS } from '../../core/ooxml';
import { parseXml, type XmlElement, XmlError, xmlAttr, xmlChild, xmlElements } from '../../core/xml';
import { openZip, ZipError, type ZipReader } from '../../core/zip';

// The parts the reader parses, together. A tree costs 20–40× its XML, and the largest document.xml met is 12.6 MB.
export const MAX_DOCX_XML_BYTES = 16 * 1024 * 1024;

// A tree costs per element too: 16 MB of empty paragraphs is 2.8 million of them and would take 3.5 GB. The corpus's
// most is 611,000 (a 178-page report); at this cap the densest file takes about 1 GB. Counted as '<' in the bytes, and
// a run's text piece past its first as one: the corpus's most is 1,055.
export const MAX_DOCX_XML_TAGS = 750_000;

export const DOCUMENT_TOO_LARGE = 'Document too large';
export const NOT_A_DOCX = 'Not a valid docx file';
const PASSWORD_PROTECTED = 'This document is password-protected. Remove the password in Word and import it again.';

export type Relationship = { type: string; target: string; external: boolean };

export type Part = { path: string; root: XmlElement; rels: Map<string, Relationship> };

export type Package = {
    zip: ZipReader;
    document: Part;
    styles?: XmlElement;
    numbering?: XmlElement;
    theme?: XmlElement;
    fontTable?: XmlElement;
    footnotes?: Part;
    endnotes?: Part;
    contentTypes: { defaults: Map<string, string>; overrides: Map<string, string> };
    // A part a drawing names, read when met and charged as the others are; a damaged one is no part.
    readPart(path: string): XmlElement | undefined;
    // A piece a run's text splits into past its first is a node, which costs what an element does.
    chargePiece(): void;
};

// An encrypted docx is an OLE compound file holding the package as a stream of this name.
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENCRYPTED_PACKAGE = Buffer.from('EncryptedPackage', 'utf16le');

// The package is read only through relationships and [Content_Types].xml, so an entry named outside them is never read.
export function readPackage(bytes: Uint8Array): Package {
    // Any other OLE file, a .doc say, is no zip, which openZip refuses.
    if (OLE_SIGNATURE.every((byte, index) => bytes[index] === byte) && Buffer.from(bytes).includes(ENCRYPTED_PACKAGE))
        throw new ApiError(400, PASSWORD_PROTECTED);
    const zip = openZip(bytes);
    const budget: Budget = {
        left: MAX_DOCX_XML_BYTES,
        tags: MAX_DOCX_XML_TAGS,
        charged: new Set(),
        parsed: new Map(),
        failed: new Map(),
    };
    const contentTypes = readContentTypes(readXml(zip, '[Content_Types].xml', budget));
    const documentPath = relOfType(readRels(zip, '', budget), 'officeDocument') ?? 'word/document.xml';
    const documentRels = readRels(zip, documentPath, budget);
    // By relationship, else where Word puts the part.
    const located = (type: string) => relOfType(documentRels, type) ?? `word/${type}.xml`;
    const notes = ['footnotes', 'endnotes'].map(located);
    // Every content part is charged before the first of them inflates.
    const parts = [documentPath, ...['styles', 'numbering', 'theme', 'fontTable'].map(located), ...notes];
    charge(zip, [...parts, ...notes.map(relsPathOf)], budget);
    const document = readXml(zip, documentPath, budget);
    if (!document) throw new ApiError(400, NOT_A_DOCX);
    // A damaged optional part, its XML or its entry, costs its looks, not the document; a cap still refuses it.
    const optional = <T>(read: () => T): T | undefined => {
        try {
            return read();
        } catch (error) {
            if (error instanceof XmlError || (error instanceof ZipError && error.status === 400)) return undefined;
            throw error;
        }
    };
    const xml = (type: string) => optional(() => readXml(zip, located(type), budget));
    const part = (type: string) =>
        optional((): Part | undefined => {
            const path = located(type);
            const root = readXml(zip, path, budget);
            return root && { path, root, rels: readRels(zip, path, budget) };
        });
    return {
        zip,
        document: { path: documentPath, root: document, rels: documentRels },
        styles: xml('styles'),
        numbering: xml('numbering'),
        theme: xml('theme'),
        fontTable: xml('fontTable'),
        footnotes: part('footnotes'),
        endnotes: part('endnotes'),
        contentTypes,
        readPart: (path) => optional(() => readXml(zip, path, budget)),
        chargePiece: () => {
            budget.tags--;
            if (budget.tags < 0) throw new ApiError(413, DOCUMENT_TOO_LARGE);
        },
    };
}

// A part several relationships name is charged and parsed once, and they share its tree or its error.
type Budget = {
    left: number;
    tags: number;
    charged: Set<string>;
    parsed: Map<string, XmlElement | undefined>;
    failed: Map<string, unknown>;
};

// Declared sizes are the cap: a read inflates no further than its entry declares (core/zip), so nothing parsed passes it.
function charge(zip: ZipReader, paths: string[], budget: Budget): void {
    const fresh = [...new Set(paths)].filter((path) => !budget.charged.has(path));
    const declared = fresh.reduce((sum, path) => sum + (zip.entry(path)?.size ?? 0), 0);
    if (declared > budget.left) throw new ApiError(413, DOCUMENT_TOO_LARGE);
    budget.left -= declared;
    for (const path of fresh) budget.charged.add(path);
}

function readXml(zip: ZipReader, path: string, budget: Budget): XmlElement | undefined {
    if (budget.parsed.has(path)) return budget.parsed.get(path);
    if (budget.failed.has(path)) throw budget.failed.get(path);
    charge(zip, [path], budget);
    try {
        const bytes = zip.read(path);
        if (!bytes) return undefined;
        for (const byte of bytes) if (byte === LESS_THAN) budget.tags--;
        if (budget.tags < 0) throw new ApiError(413, DOCUMENT_TOO_LARGE);
        const root = parseXml(bytes) ?? undefined;
        if (root) toTransitional(root);
        budget.parsed.set(path, root);
        return root;
    } catch (error) {
        budget.failed.set(path, error);
        throw error;
    }
}

const LESS_THAN = 0x3c;

function readContentTypes(root: XmlElement | undefined): Package['contentTypes'] {
    const defaults = new Map<string, string>();
    const overrides = new Map<string, string>();
    for (const entry of root ? xmlElements(root) : []) {
        const contentType = (entry.attributes['ContentType'] ?? '').toLowerCase();
        if (is(entry, CONTENT_TYPES_NS, 'Default'))
            defaults.set((entry.attributes['Extension'] ?? '').toLowerCase(), contentType);
        if (is(entry, CONTENT_TYPES_NS, 'Override'))
            overrides.set((entry.attributes['PartName'] ?? '').replace(/^\//, ''), contentType);
    }
    return { defaults, overrides };
}

export function contentTypeOf(pkg: Package, path: string): string | undefined {
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return pkg.contentTypes.overrides.get(path) ?? pkg.contentTypes.defaults.get(extension);
}

function relsPathOf(partPath: string): string {
    const slash = partPath.lastIndexOf('/');
    return `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`;
}

function readRels(zip: ZipReader, partPath: string, budget: Budget): Map<string, Relationship> {
    const root = readXml(zip, relsPathOf(partPath), budget);
    const rels = new Map<string, Relationship>();
    for (const rel of root ? xmlElements(root) : []) {
        const id = rel.attributes['Id'];
        if (!is(rel, PACKAGE_RELATIONSHIPS_NS, 'Relationship') || !id) continue;
        const target = rel.attributes['Target'] ?? '';
        const external = rel.attributes['TargetMode'] === 'External';
        rels.set(id, {
            type: rel.attributes['Type'] ?? '',
            target: external ? target : resolvePath(partPath, target),
            external,
        });
    }
    return rels;
}

function relOfType(rels: Map<string, Relationship>, type: string): string | undefined {
    for (const rel of rels.values()) if (rel.type.endsWith(`/${type}`) && !rel.external) return rel.target;
    return undefined;
}

function resolvePath(base: string, target: string): string {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/').slice(0, -1);
    for (const segment of target.split('/')) {
        if (segment === '..') parts.pop();
        else if (segment !== '.' && segment !== '') parts.push(segment);
    }
    return parts.join('/');
}

// mc:Choice prefixes whose content this reader understands; any other Choice falls back.
const UNDERSTOOD_PREFIXES = new Set([
    'w',
    'w14',
    'w15',
    'wp',
    'wp14',
    'wps',
    'wpg',
    'wpc',
    'a',
    'a14',
    'asvg',
    'pic',
    'v',
    'o',
    'w10',
    'm',
    'mc',
    'r',
]);

export function isAlternateContent(element: XmlElement): boolean {
    return is(element, MC_NS, 'AlternateContent');
}

export function alternative(element: XmlElement): XmlElement[] {
    for (const choice of xmlElements(element)) {
        if (is(choice, MC_NS, 'Choice')) {
            const requires = (choice.attributes['Requires'] ?? '').split(/\s+/).filter(Boolean);
            if (requires.every((prefix) => UNDERSTOOD_PREFIXES.has(prefix))) return xmlElements(choice);
        }
        if (is(choice, MC_NS, 'Fallback')) return xmlElements(choice);
    }
    return [];
}

// ── WordprocessingML attributes ─────────────────────────────────────────────────────────────────────────────────

export function w(element: XmlElement | undefined, local: string): string | undefined {
    return element && xmlAttr(element, W_NS, local);
}

export function wChild(element: XmlElement | undefined, local: string): XmlElement | undefined {
    return element && xmlChild(element, W_NS, local);
}

export function is(element: XmlElement, ns: string, local: string): boolean {
    return element.ns === ns && element.local === local;
}

// ST_OnOff attribute value: 1, true, on / 0, false, off, whitespace around it allowed; anything else is no answer.
export function isOn(value: string | undefined): boolean | undefined {
    const trimmed = value?.trim();
    if (trimmed === undefined) return undefined;
    if (['1', 'true', 'on'].includes(trimmed)) return true;
    return ['0', 'false', 'off'].includes(trimmed) ? false : undefined;
}

// A bare element is on.
export function onOff(element: XmlElement | undefined): boolean | undefined {
    if (!element) return undefined;
    return isOn(w(element, 'val')) ?? true;
}

export function int(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? Math.round(number) : undefined;
}

// ST_UniversalMeasure, which Strict OOXML writes where transitional writes a number: points per unit.
const POINTS_PER_UNIT = new Map([
    ['pt', 1],
    ['pc', 12],
    ['pi', 12],
    ['in', 72],
    ['cm', 72 / 2.54],
    ['mm', 72 / 25.4],
]);

// A length in twips or half-points: a bare number is in that unit, a universal measure is converted.
function measure(value: string | undefined, perPoint: number): number | undefined {
    const [, number, unit = ''] = value?.trim().match(/^(-?\d+(?:\.\d+)?)(pt|pc|pi|in|cm|mm)$/) ?? [];
    const points = POINTS_PER_UNIT.get(unit);
    return points === undefined ? int(value) : Math.round(Number(number) * points * perPoint);
}

export function twips(value: string | undefined): number | undefined {
    return measure(value, 20);
}

export function halfPoints(value: string | undefined): number | undefined {
    return measure(value, 2);
}

// Document order; a match's own content and a text box's are not searched.
export function descendants(root: XmlElement, ns: string, local: string): XmlElement[] {
    const found: XmlElement[] = [];
    const stack = xmlElements(root).reverse();
    for (let element = stack.pop(); element; element = stack.pop()) {
        if (is(element, ns, local)) found.push(element);
        else if (!is(element, W_NS, 'txbxContent')) {
            const children = xmlElements(element);
            for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
        }
    }
    return found;
}
