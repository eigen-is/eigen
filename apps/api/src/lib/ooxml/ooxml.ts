// The XML vocabulary every OOXML format shares, for its readers and its writers alike: the namespaces, a part parsed
// with Strict OOXML read as transitional, markup compatibility (mc:AlternateContent), the units and their lengths, and
// on/off values. What only one format uses, such as Word's style names, sits in that format's vocabulary module.

import { MARKUP_COMPATIBILITY_NAMESPACE, OMML_NAMESPACE, WORDML_NAMESPACE } from '@workspace/math';
import type { XmlElement } from '../core/xml';
import { hasXmlName, parseXml, xmlAttr, xmlElements } from '../core/xml';

// ── Namespaces ──────────────────────────────────────────────────────────────────────────────────────────────────

export const W_NS = WORDML_NAMESPACE;
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
export const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
export const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
export const DGM_NS = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
export const TBL_NS = 'http://schemas.openxmlformats.org/drawingml/2006/table';
// Word's drawing of a SmartArt, the shapes and their text as laid out.
export const DSP_NS = 'http://schemas.microsoft.com/office/drawing/2008/diagram';
export const SML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
// A worksheet's or chart sheet's drawing: the anchors that place its pictures and charts over the grid.
export const XDR_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
// Excel 2010's SpreadsheetML extensions, and the formulas and references they hold.
export const X14_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
export const XM_NS = 'http://schemas.microsoft.com/office/excel/2006/main';
export const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
export const OLE_NS = 'http://schemas.openxmlformats.org/presentationml/2006/ole';
export const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';
export const MC_NS = MARKUP_COMPATIBILITY_NAMESPACE;
export const ASVG_NS = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main';
export const AHYP_NS = 'http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor';
// Office 2016's chart extensions, among them a series' c16:uniqueId.
export const C16_NS = 'http://schemas.microsoft.com/office/drawing/2014/chart';
export const V_NS = 'urn:schemas-microsoft-com:vml';
export const O_NS = 'urn:schemas-microsoft-com:office:office';
export const W10_NS = 'urn:schemas-microsoft-com:office:word';
export const M_NS = OMML_NAMESPACE;
export const PACKAGE_RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
export const CORE_PROPERTIES_NS = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
export const DC_NS = 'http://purl.org/dc/elements/1.1/';

const STRICT = 'http://purl.oclc.org/ooxml';

// Strict OOXML puts the same vocabulary in namespaces of its own. Each maps onto its transitional twin, so a reader
// handles one set of names.
const STRICT_NAMESPACES = new Map([
    [`${STRICT}/wordprocessingml/main`, W_NS],
    [`${STRICT}/officeDocument/relationships`, R_NS],
    [`${STRICT}/drawingml/wordprocessingDrawing`, WP_NS],
    [`${STRICT}/drawingml/main`, A_NS],
    [`${STRICT}/drawingml/picture`, PIC_NS],
    [`${STRICT}/drawingml/chart`, C_NS],
    [`${STRICT}/drawingml/diagram`, DGM_NS],
    [`${STRICT}/drawingml/spreadsheetDrawing`, XDR_NS],
    [`${STRICT}/officeDocument/math`, M_NS],
    [`${STRICT}/spreadsheetml/main`, SML_NS],
    [`${STRICT}/presentationml/main`, P_NS],
]);

// Parses a part, reading every Strict namespace it declares as the transitional one.
export function parseOoxml(input: string | Uint8Array): XmlElement | null {
    return parseXml(input, STRICT_NAMESPACES);
}

// ── Markup compatibility ────────────────────────────────────────────────────────────────────────────────────────

export function isAlternateContent(element: XmlElement): boolean {
    return hasXmlName(element, MC_NS, 'AlternateContent');
}

// Picks the branch of an mc:AlternateContent a reader can read. That is the first mc:Choice whose Requires prefixes
// the reader all understands, else the mc:Fallback, else nothing. Each format passes the prefixes it understands.
export function alternativeFor(understood: ReadonlySet<string>): (element: XmlElement) => XmlElement[] {
    return (element) => {
        for (const choice of xmlElements(element)) {
            if (hasXmlName(choice, MC_NS, 'Choice')) {
                const requires = (choice.attributes['Requires'] ?? '').split(/\s+/).filter(Boolean);
                if (requires.every((prefix) => understood.has(prefix))) return xmlElements(choice);
            }
            if (hasXmlName(choice, MC_NS, 'Fallback')) return xmlElements(choice);
        }
        return [];
    };
}

// An element's children, with each mc:AlternateContent replaced by the branch that `alternative` picks.
export function ooxmlElements(element: XmlElement, alternative: (element: XmlElement) => XmlElement[]): XmlElement[] {
    return xmlElements(element).flatMap((item) => (isAlternateContent(item) ? alternative(item) : [item]));
}

// The first of ooxmlElements' children with this name.
export function ooxmlChild(
    element: XmlElement,
    ns: string,
    local: string,
    alternative: (element: XmlElement) => XmlElement[],
): XmlElement | undefined {
    return ooxmlElements(element, alternative).find((child) => hasXmlName(child, ns, local));
}

// ── Units ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const EMU_PER_PX = 9525;
export const EMU_PER_POINT = 12_700;

// The points in one of each unit of ST_UniversalMeasure, which Strict OOXML writes where transitional writes a number.
export const POINTS_PER_UNIT = new Map([
    ['pt', 1],
    ['pc', 12],
    ['pi', 12],
    ['in', 72],
    ['cm', 72 / 2.54],
    ['mm', 72 / 25.4],
]);

// No real length needs more characters. A longer one is ignored unread, so a crafted 4 MB value is not scanned at
// every use.
const MAX_MEASURE_CHARS = 64;

// An ST_Coordinate in EMU, or a universal measure converted to EMU. Anything else is undefined, and so is a value
// too large for a double to hold exactly.
export function emu(value: string | undefined): number | undefined {
    if (value === undefined || value.length > MAX_MEASURE_CHARS) return undefined;
    const [, number, unit = ''] = value.trim().match(/^(-?\d+(?:\.\d+)?)([a-z]*)$/) ?? [];
    const points = POINTS_PER_UNIT.get(unit);
    const result =
        unit === '' ? Number(number) : points === undefined ? Number.NaN : Number(number) * points * EMU_PER_POINT;
    return Number.isFinite(result) && Math.abs(result) <= Number.MAX_SAFE_INTEGER ? result : undefined;
}

// A length in a unit with `perPoint` of them to the point, such as twips (20) or half-points (2), rounded. A
// universal measure is converted. Anything else is read as a plain number in that unit.
export function measure(value: string | undefined, perPoint: number): number | undefined {
    if (value === undefined || value.length > MAX_MEASURE_CHARS) return undefined;
    const [, number, unit = ''] = value.trim().match(/^(-?\d+(?:\.\d+)?)([a-z]+)$/) ?? [];
    const points = POINTS_PER_UNIT.get(unit);
    const result = points === undefined ? Number.parseFloat(value) : Number(number) * points * perPoint;
    return Number.isFinite(result) ? Math.round(result) : undefined;
}

// ── Values ──────────────────────────────────────────────────────────────────────────────────────────────────────

// An ST_OnOff value: 1, true or on, and 0, false or off, with whitespace around it allowed. Anything else is undefined.
export function isOn(value: string | undefined): boolean | undefined {
    const trimmed = value?.trim();
    if (trimmed === undefined) return undefined;
    if (['1', 'true', 'on'].includes(trimmed)) return true;
    return ['0', 'false', 'off'].includes(trimmed) ? false : undefined;
}

// A CT_OnOff or CT_Boolean element. An element without a val is on, and a missing element is undefined.
// WordprocessingML puts the val attribute in its own namespace, so its readers pass that as `ns`.
export function isOnElement(element: XmlElement | undefined, ns = ''): boolean | undefined {
    return element ? (isOn(xmlAttr(element, ns, 'val')) ?? true) : undefined;
}
