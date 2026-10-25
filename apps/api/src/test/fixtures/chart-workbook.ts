// A chart part's refs read against the sheet its workbook holds: for each c:f, the points its cache holds and the cells
// it names, both as text by index, so a test pins that every cell a ref points at holds what the cache does.

import type { Sheet } from '@workspace/lib/sheets';
import { parseA1Range } from '@workspace/sheet/engine/a1-notation';
import type { XmlElement } from '../../lib/core/xml';
import { hasXmlName, xmlAttr, xmlChild, xmlChildren, xmlElements, xmlText, xmlTrimmedText } from '../../lib/core/xml';
import { xlsxToSheets } from '../../lib/import/sheets/from-xlsx';
import { C_NS, parseOoxml, R_NS } from '../../lib/ooxml/ooxml';
import { relationshipsOf, relsPathOf, relTarget } from '../../lib/ooxml/opc';
import type { ZipReader } from '../../lib/ooxml/zip';

// A docx's or pptx's chart part and the first sheet of the workbook its c:externalData names, as the xlsx import reads
// it, and that workbook's path.
export function embeddedWorkbookOf(
    zip: ZipReader,
    chartPath: string,
): { chart: XmlElement; sheet: Sheet; path: string } {
    const parse = (path: string) => {
        const bytes = zip.read(path);
        const root = bytes && parseOoxml(bytes);
        if (!root) throw new Error(`${path} missing`);
        return root;
    };
    const chart = parse(chartPath);
    const external = xmlChild(chart, C_NS, 'externalData');
    const rels = relationshipsOf(parse(relsPathOf(chartPath)), chartPath);
    const path = relTarget(rels, external && xmlAttr(external, R_NS, 'id'), 'package');
    const bytes = path && zip.read(path);
    if (!path || !bytes) throw new Error(`${chartPath} names no workbook`);
    const [sheet] = xlsxToSheets(bytes);
    if (!sheet) throw new Error(`${path} holds no sheet`);
    return { chart, sheet, path };
}

export type RefAgainstCells = { formula: string; cache: (string | undefined)[]; cells: (string | undefined)[] };

export function refsAgainstCells(chart: XmlElement, sheet: Sheet): RefAgainstCells[] {
    const refs: XmlElement[] = [];
    const walk = (element: XmlElement) => {
        if (hasXmlName(element, C_NS, 'strRef') || hasXmlName(element, C_NS, 'numRef')) refs.push(element);
        for (const child of xmlElements(element)) walk(child);
    };
    walk(chart);
    const cell = (r: number, c: number) => {
        const value = sheet.celldata?.find((entry) => entry.r === r && entry.c === c)?.v?.v;
        return value === undefined ? undefined : String(value);
    };
    return refs.map((ref) => {
        const formula = xmlTrimmedText(xmlChild(ref, C_NS, 'f'));
        const range = parseA1Range(formula.slice(formula.lastIndexOf('!') + 1));
        if (!range) throw new Error(`not a range: ${formula}`);
        const cells: (string | undefined)[] = [];
        for (let r = range.start.row; r <= range.end.row; r++) {
            for (let c = range.start.col; c <= range.end.col; c++) cells.push(cell(r, c));
        }
        const held = xmlChild(ref, C_NS, 'strCache') ?? xmlChild(ref, C_NS, 'numCache');
        const count = Number(xmlAttr(held ? (xmlChild(held, C_NS, 'ptCount') ?? held) : ref, '', 'val'));
        const cache = new Array<string | undefined>(Number.isInteger(count) ? count : 0).fill(undefined);
        for (const point of held ? xmlChildren(held, C_NS, 'pt') : []) {
            const v = xmlChild(point, C_NS, 'v');
            cache[Number(xmlAttr(point, '', 'idx'))] = v ? xmlText(v) : undefined;
        }
        return { formula, cache, cells };
    });
}
