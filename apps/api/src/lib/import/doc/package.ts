import { ApiError } from '../../core/errors';
import { alternativeFor, isOn, W_NS } from '../../core/ooxml';
import { type OoxmlPackage, openPackage, optional, type Relationship, relOfType } from '../../core/opc';
import { hasXmlName, type XmlElement, xmlAttr, xmlChild, xmlElements } from '../../core/xml';
import type { ZipReader } from '../../core/zip';

export const NOT_A_DOCX = 'Not a valid docx file';
const PASSWORD_PROTECTED = 'This document is password-protected. Remove the password in Word and import it again.';

export type Part = { path: string; root: XmlElement; rels: Map<string, Relationship> };

export type DocxPackage = {
    zip: ZipReader;
    document: Part;
    styles?: XmlElement;
    numbering?: XmlElement;
    theme?: XmlElement;
    fontTable?: XmlElement;
    footnotes?: Part;
    endnotes?: Part;
    contentTypeOf: OoxmlPackage['contentTypeOf'];
    // A part a drawing names, read when met; a damaged one is no part.
    readPart(path: string): XmlElement | undefined;
    // An image's bytes; a damaged entry is none, and costs only its picture.
    readMedia(path: string): Uint8Array | undefined;
};

export function readPackage(bytes: Uint8Array): DocxPackage {
    const pkg = openPackage(bytes, PASSWORD_PROTECTED);
    const documentPath = relOfType(pkg.relationships(''), 'officeDocument') ?? 'word/document.xml';
    const documentRels = pkg.relationships(documentPath);
    // By relationship, else where Word puts the part.
    const located = (type: string) => relOfType(documentRels, type) ?? `word/${type}.xml`;
    const document = pkg.part(documentPath);
    if (!document) throw new ApiError(400, NOT_A_DOCX);
    const xml = (type: string) => optional(() => pkg.part(located(type)));
    const part = (type: string) =>
        optional((): Part | undefined => {
            const path = located(type);
            const root = pkg.part(path);
            return root && { path, root, rels: pkg.relationships(path) };
        });
    return {
        zip: pkg.zip,
        document: { path: documentPath, root: document, rels: documentRels },
        styles: xml('styles'),
        numbering: xml('numbering'),
        theme: xml('theme'),
        fontTable: xml('fontTable'),
        footnotes: part('footnotes'),
        endnotes: part('endnotes'),
        contentTypeOf: pkg.contentTypeOf,
        readPart: (path) => optional(() => pkg.part(path)),
        readMedia: (path) => optional(() => pkg.zip.read(path)),
    };
}

// Requires names prefixes, not namespaces: Word's spellings of the namespaces this reader reads.
const WORD_PREFIXES = new Set([
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

export const alternative = alternativeFor(WORD_PREFIXES);

// ── WordprocessingML attributes ─────────────────────────────────────────────────────────────────────────────────

export function w(element: XmlElement | undefined, local: string): string | undefined {
    return element && xmlAttr(element, W_NS, local);
}

export function wChild(element: XmlElement | undefined, local: string): XmlElement | undefined {
    return element && xmlChild(element, W_NS, local);
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
export const POINTS_PER_UNIT = new Map([
    ['pt', 1],
    ['pc', 12],
    ['pi', 12],
    ['in', 72],
    ['cm', 72 / 2.54],
    ['mm', 72 / 25.4],
]);

// A length in twips or half-points: a bare number is in that unit, a universal measure is converted.
function measure(value: string | undefined, perPoint: number): number | undefined {
    const [, number, unit = ''] = value?.trim().match(/^(-?\d+(?:\.\d+)?)([a-z]+)$/) ?? [];
    const points = POINTS_PER_UNIT.get(unit);
    return points === undefined ? int(value) : Math.round(Number(number) * points * perPoint);
}

export function twipsOf(value: string | undefined): number | undefined {
    return measure(value, 20);
}

export function halfPointsOf(value: string | undefined): number | undefined {
    return measure(value, 2);
}

// Document order; a match's own content and a text box's are not searched.
export function descendants(root: XmlElement, ns: string, local: string): XmlElement[] {
    const found: XmlElement[] = [];
    const stack = xmlElements(root).reverse();
    for (let element = stack.pop(); element; element = stack.pop()) {
        if (hasXmlName(element, ns, local)) found.push(element);
        else if (!hasXmlName(element, W_NS, 'txbxContent')) {
            const children = xmlElements(element);
            for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
        }
    }
    return found;
}
