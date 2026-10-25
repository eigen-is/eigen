// The docx package as the reader reads it: the document part, the parts it names (styles, numbering, theme, notes, the
// final section's headers and footers), the caps a crafted file is held to, and the WordprocessingML attribute
// helpers every reader file shares.

import type { BandRoot } from '@workspace/lib/docs/eigendoc';
import { BAND_ROOTS, bandEdge, FIRST_PAGE_BAND, TWIPS_PER_POINT } from '@workspace/lib/docs/eigendoc';
import { ApiError } from '../../core/errors';
import type { XmlElement } from '../../core/xml';
import { hasXmlName, xmlAttr, xmlChild, xmlElements } from '../../core/xml';
import type { Lost } from '../../document/transform/protocol';
import type { Budget } from '../../ooxml/budget';
import { budget } from '../../ooxml/budget';
import { alternativeFor, isOnElement, measure, R_NS, W_NS } from '../../ooxml/ooxml';
import type { OoxmlPackage, Part } from '../../ooxml/opc';
import { openPackage, optional, relOfType } from '../../ooxml/opc';
import type { ZipReader } from '../../ooxml/zip';
import { IMPORT_MESSAGES } from '../messages';

// A piece past a run's first is a node no tag counts, about 600 bytes held before the output is weighed; the corpus's
// most is 1,055.
export const MAX_DOCX_PIECES = 75_000;

// Each node and mark the reader emits is a Yjs item: 1.3 to 2.4 KB of peak memory through the transform per unit of
// weight, 3.8 KB for a cell's 63 column widths. At this budget the heaviest file met peaks near 1 GB, and the corpus's
// heaviest weighs 57,688.
export const MAX_DOCX_WEIGHT = 150_000;

// readChart builds every point a cache declares before the spec's cap refuses them, a few tags each up to 68,000 slots,
// so a file of many small chart parts is bounded by their cost (chartCost) together. The corpus's most is 1,740.
export const MAX_DOCX_CHART_WORK = 1_000_000;

// A string attribute is spelled out in the update for every node or mark that carries it: about 3.5 bytes a character.
export const CHARS_PER_UNIT = 512;

export type DocxPackage = {
    zip: ZipReader;
    document: Part;
    styles?: XmlElement;
    numbering?: XmlElement;
    theme?: XmlElement;
    fontTable?: XmlElement;
    footnotes?: Part;
    endnotes?: Part;
    // The final section's headers and footers, a first-page one only with w:titlePg, which makes page 1 different.
    bands: Partial<Record<BandRoot, Part>>;
    titlePg: boolean;
    contentTypeOf: OoxmlPackage['contentTypeOf'];
    // A part a drawing names, read when met; a damaged one is no part.
    part(path: string): XmlElement | undefined;
    readMedia: OoxmlPackage['readMedia'];
    // A piece a run's text splits into past its first is a node no XML tag counts, so it has a cap of its own, as has
    // each node of a note's copy past its first.
    pieces: Budget;
    // An equation's MathML is charged as it is written: a space in m:t writes 26 characters, so a few KB zipped would
    // build hundreds of MB before the output is weighed.
    mathml: Budget;
    // A chart's read cost (chartCost), spent only when the allowance left covers it: one it can't is left out. Its spec
    // string still weighs in the output budget, so enough charts can refuse the document.
    charts: Budget;
};

// Counts in `lost` the bands the file names that no doc holds: an even page's, which Word draws only with
// evenAndOddHeaders, and one in a part that is missing or damaged.
export function readPackage(bytes: Uint8Array, lost: Lost): DocxPackage {
    const pkg = openPackage(bytes, IMPORT_MESSAGES.docx);
    const { tooLarge } = IMPORT_MESSAGES.docx;
    const documentPath = relOfType(pkg.relationships(''), 'officeDocument') ?? 'word/document.xml';
    const documentRels = pkg.relationships(documentPath);
    // By relationship, else where Word puts the part.
    const located = (type: string) => relOfType(documentRels, type) ?? `word/${type}.xml`;
    const document = pkg.part(documentPath);
    if (!document) throw new ApiError(400, IMPORT_MESSAGES.docx.invalid);
    const xml = (type: string) => optional(() => pkg.part(located(type)));
    const part = (type: string) =>
        optional((): Part | undefined => {
            const path = located(type);
            const root = pkg.part(path);
            return root && { path, root, rels: pkg.relationships(path) };
        });
    // Word takes a reference a section leaves out from the section before it, so the last one of each type is the final
    // section's. A first-page band shows only where the final section has w:titlePg, an even one only with the setting.
    const references = new Map<string, string>();
    for (const section of descendants(document, W_NS, 'sectPr'))
        for (const reference of xmlElements(section)) {
            const id = xmlAttr(reference, R_NS, 'id');
            const kind = BAND_REFERENCES.get(reference.local);
            if (reference.ns === W_NS && kind && id) references.set(`${kind}:${w(reference, 'type') ?? 'default'}`, id);
        }
    const titlePg = onOff(wChild(wChild(wChild(document, 'body'), 'sectPr'), 'titlePg')) === true;
    const bands: Partial<Record<BandRoot, Part>> = {};
    for (const root of BAND_ROOTS) {
        const edge = bandEdge(root);
        const first = root === FIRST_PAGE_BAND[edge];
        const id = references.get(`${edge}:${first ? 'first' : 'default'}`);
        const rel = id ? documentRels.get(id) : undefined;
        if (!rel || rel.external || !rel.type.endsWith(`/${edge}`) || (first && !titlePg)) continue;
        const band = optional((): Part | undefined => {
            const tree = pkg.part(rel.target);
            return tree && { path: rel.target, root: tree, rels: pkg.relationships(rel.target) };
        });
        if (band) bands[root] = band;
        else lost('band-content-dropped');
    }
    const even = ['header:even', 'footer:even'].filter((key) => references.has(key));
    if (even.length > 0 && onOff(wChild(xml('settings'), 'evenAndOddHeaders')) === true)
        for (const _ of even) lost('even-bands-dropped');
    return {
        zip: pkg.zip,
        document: { path: documentPath, root: document, rels: documentRels },
        styles: xml('styles'),
        numbering: xml('numbering'),
        theme: xml('theme'),
        fontTable: xml('fontTable'),
        footnotes: part('footnotes'),
        endnotes: part('endnotes'),
        bands,
        titlePg,
        contentTypeOf: pkg.contentTypeOf,
        part: (path) => optional(() => pkg.part(path)),
        readMedia: pkg.readMedia,
        pieces: budget(MAX_DOCX_PIECES, tooLarge),
        mathml: budget(MAX_DOCX_WEIGHT * CHARS_PER_UNIT, tooLarge),
        charts: budget(MAX_DOCX_CHART_WORK, tooLarge),
    };
}

const BAND_REFERENCES = new Map([
    ['headerReference', 'header'],
    ['footerReference', 'footer'],
]);

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

export function onOff(element: XmlElement | undefined): boolean | undefined {
    return isOnElement(element, W_NS);
}

export function int(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? Math.round(number) : undefined;
}

export function twipsOf(value: string | undefined): number | undefined {
    return measure(value, TWIPS_PER_POINT);
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
