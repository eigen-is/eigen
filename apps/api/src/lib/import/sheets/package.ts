import { ApiError } from '../../core/errors';
import type { XmlElement } from '../../core/xml';
import { hasXmlName, XmlError, xmlAttr, xmlChild, xmlChildren } from '../../core/xml';
import { isOn, parseOoxml, R_NS, SML_NS } from '../../ooxml/ooxml';
import type { OoxmlPackage } from '../../ooxml/opc';
import { MAX_PACKAGE_XML_BYTES, MAX_PACKAGE_XML_TAGS, openPackage, optional, relOfType, tagsIn } from '../../ooxml/opc';
import { IMPORT_MESSAGES } from '../messages';

// The xlsx package: the workbook part, its sheets and the parts every sheet shares, and a part's children read a batch
// at a time, since a sheet's grid and the shared strings can each be the whole decompressed cap.

// A chart sheet is a sheet without a grid, holding its drawing's chart.
export type WorkbookSheet = { name: string; path: string; hidden: boolean; chartSheet: boolean };

export type XlsxPackage = {
    pkg: OoxmlPackage;
    // In the workbook's order.
    sheets: WorkbookSheet[];
    date1904: boolean;
    styles?: XmlElement;
    theme?: XmlElement;
    // Bytes, as readInBatches reads them.
    sharedStrings?: Uint8Array;
};

export function readPackage(bytes: Uint8Array): XlsxPackage {
    const pkg = openPackage(bytes, IMPORT_MESSAGES.xlsx);
    // By relationship, else where Excel puts the part.
    const workbookPath = relOfType(pkg.relationships(''), 'officeDocument') ?? 'xl/workbook.xml';
    const workbook = pkg.part(workbookPath);
    if (!workbook || !hasXmlName(workbook, SML_NS, 'workbook')) throw new ApiError(400, IMPORT_MESSAGES.xlsx.invalid);
    const rels = pkg.relationships(workbookPath);
    const located = (type: string, path: string) => relOfType(rels, type) ?? path;
    const list = xmlChild(workbook, SML_NS, 'sheets');
    const entries = (list ? xmlChildren(list, SML_NS, 'sheet') : []).flatMap((sheet): WorkbookSheet[] => {
        const name = xmlAttr(sheet, '', 'name');
        const rel = rels.get(xmlAttr(sheet, R_NS, 'id') ?? '');
        const chartSheet = rel?.type.endsWith('/chartsheet') === true;
        if (name === undefined || !rel || rel.external || !(chartSheet || rel.type.endsWith('/worksheet'))) return [];
        const hidden = (xmlAttr(sheet, '', 'state') ?? 'visible') !== 'visible';
        return [{ name, path: rel.target, hidden, chartSheet }];
    });
    // One sheet per part, named and placed by the last entry naming it; read per entry, a part would be inflated and
    // parsed again for each.
    const last = new Map(entries.map((sheet, index) => [sheet.path, index]));
    const sheets = entries.filter((sheet, index) => last.get(sheet.path) === index);
    const properties = xmlChild(workbook, SML_NS, 'workbookPr');
    return {
        pkg,
        sheets,
        date1904: isOn(properties && xmlAttr(properties, '', 'date1904')) === true,
        // A damaged styles or theme part costs the looks, not the workbook.
        styles: optional(() => pkg.part(located('styles', 'xl/styles.xml'))),
        theme: optional(() => pkg.part(located('theme', 'xl/theme/theme1.xml'))),
        sharedStrings: pkg.zip.read(located('sharedStrings', 'xl/sharedStrings.xml')),
    };
}

// A batch's length of children past its first; a batch is at least as long as the start tags it repeats, so a part
// parses in at most twice its length.
export const BATCH_BYTES = 1024 * 1024;

// A batch ends at the first child past BATCH_BYTES, so one long row or shared string is a batch of its own, parsed as
// one tree: past this it is refused. The corpus's longest is a 2.5 MB row.
export const MAX_BATCH_BYTES = 12 * 1024 * 1024;

// A node costs its parse and its memory whatever it emits, so the grids and the shared strings are charged their
// elements before the first batch of a part is parsed, together, and a sqref its references before they are parsed: a
// file of empty cells, rows or strings is refused before any is read. The 1,050 workbooks of the corpus hold at most
// 7.3M (a Zenodo workbook of a million rows); a little over twice that keeps the cheapest flood, empty strings parsed at
// about 0.3 µs each, near 5 s.
export const MAX_XLSX_ELEMENTS = 16_000_000;

export type ReadBudget = {
    // Throws past MAX_XLSX_ELEMENTS.
    chargeElements(count: number): void;
    // Charged only when what is left covers it: a chart past it is left out, not the workbook.
    spendElements(count: number): boolean;
    // Called with what is about to be parsed whole: a sheet's or the shared strings' part past its batches, or a part
    // whose cut can't be checked. These never pass through openPackage's part(), so they have a budget of its values
    // of their own, together across the parts; the corpus's most is 1.6 MB and 50,000 tags. Throws past it.
    chargeWhole(text: Uint8Array): void;
};

export function readBudget(): ReadBudget {
    const spent = { elements: 0, wholeBytes: 0, wholeTags: 0 };
    return {
        chargeElements(count) {
            spent.elements += count;
            if (spent.elements > MAX_XLSX_ELEMENTS) throw new ApiError(413, IMPORT_MESSAGES.xlsx.tooLarge);
        },
        spendElements(count) {
            if (spent.elements + count > MAX_XLSX_ELEMENTS) return false;
            spent.elements += count;
            return true;
        },
        chargeWhole(text) {
            spent.wholeBytes += text.length;
            if (spent.wholeBytes > MAX_PACKAGE_XML_BYTES) throw new ApiError(413, IMPORT_MESSAGES.xlsx.tooLarge);
            spent.wholeTags += tagsIn(text);
            if (spent.wholeTags > MAX_PACKAGE_XML_TAGS) throw new ApiError(413, IMPORT_MESSAGES.xlsx.tooLarge);
        },
    };
}

// Bun has no streaming XML and a tree costs about 100× its text (core/xml.ts), so the children of the root, or of its
// child `container`, are parsed a batch at a time behind the part's prolog and start tags, so prefixes bind and a
// DOCTYPE is still refused. The cut is checked: the rest must parse with a marker in the children's place, and each
// batch alone, else the part is parsed whole. The rest is parsed first, so it is read before the children.
export function readInBatches(
    part: Uint8Array,
    container: string | undefined,
    child: string,
    budget: ReadBudget,
): { rest: XmlElement | undefined; children: Iterable<XmlElement> } {
    const holderOf = (root: XmlElement | undefined) => (root && container ? xmlChild(root, SML_NS, container) : root);
    const childrenOf = (root: XmlElement | undefined) => {
        const holder = holderOf(root);
        return holder ? xmlChildren(holder, SML_NS, child) : [];
    };
    const text = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
    const span = childrenSpan(text, container);
    const restText = span && Buffer.concat([text.subarray(0, span.start), MARKER, text.subarray(span.end)]);
    if (restText) budget.chargeWhole(restText);
    const rest = restText && parseCut(restText);
    const holder = holderOf(rest);
    if (!span || !holder?.children.some(isMarker)) {
        budget.chargeWhole(text);
        const whole = parseOoxml(part) ?? undefined;
        return { rest: whole, children: childrenOf(whole) };
    }
    holder.children = holder.children.filter((node) => !isMarker(node));
    budget.chargeElements(elementsIn(text.subarray(span.start, span.end)));
    function* batches(within: Span): Generator<XmlElement> {
        const open = Buffer.from(`<${within.prefix}${child}`);
        const step = Math.max(BATCH_BYTES, within.wrapper.length);
        // Parsed again in front of every batch, so charged again for every batch.
        const wrapperElements = elementsIn(within.wrapper);
        let read = 0;
        for (let at = within.start; at < within.end; ) {
            const next = at + step < within.end ? findTag(text, open, at + step) : -1;
            const end = next < 0 || next > within.end ? within.end : next;
            if (end - at > MAX_BATCH_BYTES) throw new ApiError(413, IMPORT_MESSAGES.xlsx.tooLarge);
            budget.chargeElements(wrapperElements);
            const batch = parseCut(Buffer.concat([within.wrapper, text.subarray(at, end), within.closing]));
            if (!batch) {
                // A cut a comment, CDATA or an instruction hides breaks the batch it ends; the batches before it ended at
                // a child, so the part is read whole past the children they held.
                budget.chargeWhole(text);
                yield* childrenOf(parseOoxml(part) ?? undefined).slice(read);
                return;
            }
            const children = childrenOf(batch);
            read += children.length;
            yield* children;
            at = end;
        }
    }
    return { rest, children: batches(span) };
}

const MARKER_NS = 'urn:eigen:batched-children';
const MARKER = Buffer.from(`<cut xmlns="${MARKER_NS}"/>`);

function isMarker(node: XmlElement['children'][number]): boolean {
    return typeof node === 'object' && 'ns' in node && node.ns === MARKER_NS;
}

// Malformed XML here is no verdict: the cut may sit in a comment, CDATA or an instruction, so the part is then read
// whole.
function parseCut(text: Buffer): XmlElement | undefined {
    try {
        return parseOoxml(text) ?? undefined;
    } catch (error) {
        if (error instanceof XmlError) return undefined;
        throw error;
    }
}

type Span = {
    // The children's text.
    start: number;
    end: number;
    // The prolog and the start tags around the children, and their end tags.
    wrapper: Buffer;
    closing: Buffer;
    // The root's prefix, with its colon: the children's name is searched with it.
    prefix: string;
};

function childrenSpan(text: Buffer, container: string | undefined): Span | undefined {
    const root = startTag(text, rootStart(text));
    if (!root) return undefined;
    const prefix = root.name.slice(0, root.name.indexOf(':') + 1);
    const head = text.subarray(0, root.end);
    if (container === undefined) {
        const end = text.lastIndexOf(`</${root.name}`);
        if (end < root.end) return undefined;
        return { start: root.end, end, wrapper: head, closing: Buffer.from(`</${root.name}>`), prefix };
    }
    const name = `${prefix}${container}`;
    const open = startTag(text, findTag(text, Buffer.from(`<${name}`), root.end));
    const end = open ? findTag(text, Buffer.from(`</${name}`), open.end) : -1;
    if (!open || end < 0) return undefined;
    return {
        start: open.end,
        end,
        wrapper: Buffer.concat([head, text.subarray(open.at, open.end)]),
        closing: Buffer.from(`</${name}></${root.name}>`),
        prefix,
    };
}

const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const SLASH = 0x2f;
const QUOTES = new Set([0x22, 0x27]);
const SPACES = new Set([0x20, 0x09, 0x0a, 0x0d]);
// Whitespace, `/` or `>` ends a name, so `<rows` is no `<row`.
const NAME_ENDS = new Set([...SPACES, SLASH, GREATER_THAN]);

// A '<' that opens an element, a comment or an instruction; an end tag adds no node.
function elementsIn(text: Uint8Array): number {
    let elements = 0;
    // A plain walk: indexOf's call per '<' is ten times slower on a part of empty elements.
    for (let at = 0; at < text.length; at++) if (text[at] === LESS_THAN && text[at + 1] !== SLASH) elements++;
    return elements;
}

// Past a BOM, the XML declaration, comments and processing instructions; -1 for anything else, a DOCTYPE or UTF-16
// say, which a whole parse reads or refuses.
function rootStart(text: Buffer): number {
    let at = text[0] === 0xef && text[1] === 0xbb && text[2] === 0xbf ? 3 : 0;
    while (at < text.length) {
        if (SPACES.has(text[at])) at++;
        else if (text[at] !== LESS_THAN) return -1;
        else if (text[at + 1] === 0x3f) at = skipPast(text, '?>', at + 2);
        else if (text.toString('latin1', at, at + 4) === '<!--') at = skipPast(text, '-->', at + 4);
        else return text[at + 1] === 0x21 ? -1 : at;
    }
    return -1;
}

function skipPast(text: Buffer, close: string, from: number): number {
    const end = text.indexOf(close, from);
    return end < 0 ? text.length : end + close.length;
}

// The start tag at `at`, to past its `>`; an attribute value may hold `>`. An empty element has no children to batch.
function startTag(text: Buffer, at: number): { at: number; end: number; name: string } | undefined {
    if (at < 0) return undefined;
    let quote: number | undefined;
    for (let index = at + 1; index < text.length; index++) {
        const byte = text[index];
        if (quote !== undefined) {
            if (byte === quote) quote = undefined;
        } else if (QUOTES.has(byte)) quote = byte;
        else if (byte === LESS_THAN) return undefined;
        else if (byte === GREATER_THAN) {
            if (text[index - 1] === SLASH) return undefined;
            let nameEnd = at + 1;
            while (nameEnd < index && !NAME_ENDS.has(text[nameEnd])) nameEnd++;
            return { at, end: index + 1, name: text.toString('utf8', at + 1, nameEnd) };
        }
    }
    return undefined;
}

// Where a tag of exactly this name starts, not a longer name's.
function findTag(text: Buffer, open: Buffer, from: number): number {
    for (let at = text.indexOf(open, from); at >= 0; at = text.indexOf(open, at + 1))
        if (NAME_ENDS.has(text[at + open.length])) return at;
    return -1;
}
