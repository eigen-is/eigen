import {
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    type Sheet,
    type SheetChart,
    sheetChartBox,
    sheetColumnsWidth,
    sheetRowsHeight,
} from '@workspace/lib/sheets';
import { generateKeyBetween } from '@workspace/lib/vector';
import type { DrawingTheme } from '../../core/drawingml';
import {
    A_NS,
    alternativeFor,
    C_NS,
    EMU_PER_PX,
    emu,
    isAlternateContent,
    R_NS,
    SML_NS,
    XDR_NS,
} from '../../core/ooxml';
import { chartCost, chartPart, readChart } from '../../core/ooxml-chart';
import { type OoxmlPackage, optional, type Relationship, relTarget } from '../../core/opc';
import { hasXmlName, type XmlElement, xmlAttr, xmlChild, xmlElements, xmlTrimmedText } from '../../core/xml';

// A worksheet's or a chart sheet's drawing: the anchors that place its charts over the grid, each read into a
// SheetChart. Pictures and shapes are not read. A chart's refs may name any sheet, so the charts are placed once every
// sheet has its id.

export type Drawing = {
    sheet: Sheet;
    // A chart sheet holds its one chart at its top left.
    chartSheet: boolean;
    anchors: XmlElement[];
    rels: ReadonlyMap<string, Relationship>;
};

// Excel's chart sheet at its default page, for one whose anchor names no size.
export const CHART_SHEET_SIZE = { width: 977, height: 638 };

// Requires names prefixes, not namespaces: the drawing vocabulary this reader reads. A chartex choice (waterfall,
// funnel, …) falls back to its shape.
const alternative = alternativeFor(new Set(['xdr', 'a', 'r', 'c']));

const ANCHORS = new Set(['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor']);

// The anchors of the drawing a sheet's part names; none when the part is missing, damaged or no drawing.
export function readDrawing(
    pkg: OoxmlPackage,
    rest: XmlElement | undefined,
    rels: ReadonlyMap<string, Relationship>,
): Pick<Drawing, 'anchors' | 'rels'> | undefined {
    const reference = rest && xmlChild(rest, SML_NS, 'drawing');
    const path = relTarget(rels, reference && xmlAttr(reference, R_NS, 'id'), 'drawing');
    const root = path === undefined ? undefined : optional(() => pkg.part(path));
    if (!path || !root || !hasXmlName(root, XDR_NS, 'wsDr')) return undefined;
    return {
        anchors: elements(root).filter((element) => element.ns === XDR_NS && ANCHORS.has(element.local)),
        rels: optional(() => pkg.relationships(path)) ?? new Map(),
    };
}

export type ChartContext = {
    pkg: OoxmlPackage;
    theme: DrawingTheme;
    // A sheet's id by the name the workbook writes, lower-cased.
    sheetIds: ReadonlyMap<string, string>;
    // A chart's elements, charged only when the budget left covers it: one it can't is left out.
    spend(count: number): boolean;
    // Throws past the output budget, which a chart's spec string counts toward: enough charts refuse the workbook.
    charge(cells: number, text: number): void;
};

// Each drawing's charts onto its sheet in file order, as chart-0, chart-1, … across the workbook; answers how many were
// left out: a chart the reader can't draw, a part missing or damaged, a place no anchor names, one past the budget, and
// each of Excel 2016's charts. A part is read once however many anchors name it, and each chart costs its elements and
// points (chartCost) and the tracks walked to place it.
export function placeCharts(drawings: Drawing[], context: ChartContext): number {
    const costs = new Map<XmlElement, number>();
    const specs = new Map<XmlElement, string | undefined>();
    let placed = 0;
    let dropped = 0;
    for (const { sheet, chartSheet, anchors, rels } of drawings) {
        for (const rel of rels.values()) if (rel.type.endsWith('/chartEx')) dropped++;
        let index: string | null = null;
        for (const anchor of anchors) {
            const reference = chartIn(anchor);
            if (!reference) continue;
            const root = chartPart(context.pkg, rels, xmlAttr(reference, R_NS, 'id'), 'xl/charts/');
            const from = markerOf(xmlChild(anchor, XDR_NS, 'from'));
            const to = markerOf(xmlChild(anchor, XDR_NS, 'to'));
            const tracks = chartSheet ? 0 : [from, to].reduce((sum, at) => sum + (at ? at.col + at.row : 0), 0);
            if (root && !costs.has(root)) costs.set(root, chartCost(root));
            const cost = root && costs.get(root);
            const spec = root && cost !== undefined && context.spend(cost + tracks) ? specOf(root) : undefined;
            const box = spec && (chartSheet ? chartSheetBox(anchor) : anchorBox(anchor, from, to, sheet));
            if (!spec || !box) {
                dropped++;
                continue;
            }
            context.charge(0, spec.length);
            index = generateKeyBetween(index, null);
            const chart: SheetChart = { id: `chart-${placed++}`, index, ...box, spec };
            (sheet.charts ??= {})[chart.id] = chart;
            if (chartSheet) break;
        }
    }
    return dropped;

    // By the cells it names; a ref the sheet can't follow, a literal, a defined name, several areas, an area or a sheet
    // not in the workbook, brings the caches' numbers inline instead, which show but follow no cell.
    function specOf(root: XmlElement): string | undefined {
        if (specs.has(root)) return specs.get(root);
        let missed = false;
        const ranges = (name: string) => {
            const id = context.sheetIds.get(name.toLowerCase());
            if (id === undefined) missed = true;
            return id;
        };
        const ranged = readChart(root, { theme: context.theme, data: { ranges } });
        const read = 'spec' in ranged && !missed ? ranged : readChart(root, { theme: context.theme, data: 'cache' });
        const spec = 'spec' in read ? JSON.stringify(read.spec) : undefined;
        specs.set(root, spec);
        return spec;
    }
}

// The c:chart an anchor's graphic frame shows.
function chartIn(anchor: XmlElement): XmlElement | undefined {
    const frame = elements(anchor).find((element) => hasXmlName(element, XDR_NS, 'graphicFrame'));
    const graphic = frame && xmlChild(frame, A_NS, 'graphic');
    const data = graphic && xmlChild(graphic, A_NS, 'graphicData');
    return data && xmlChild(data, C_NS, 'chart');
}

type Marker = { col: number; colOff: number; row: number; rowOff: number };

// A cell in Excel's grid and the EMU into it.
function markerOf(element: XmlElement | undefined): Marker | undefined {
    const text = (local: string) => {
        const child = element && xmlChild(element, XDR_NS, local);
        return child && xmlTrimmedText(child);
    };
    const col = Number(text('col'));
    const row = Number(text('row'));
    if (!Number.isInteger(col) || col < 0 || col >= REFERENCE_COLUMN_COUNT) return undefined;
    if (!Number.isInteger(row) || row < 0 || row >= REFERENCE_ROW_COUNT) return undefined;
    return { col, colOff: emu(text('colOff')) ?? 0, row, rowOff: emu(text('rowOff')) ?? 0 };
}

type Box = Pick<SheetChart, 'x' | 'y' | 'width' | 'height'>;

// In grid px from A1: a two-cell anchor over the same cells as in Excel, through the sheet's own widths and heights,
// between its corners whichever comes first; a one-cell anchor from its cell at its size; an absolute one where it
// says.
function anchorBox(
    anchor: XmlElement,
    from: Marker | undefined,
    to: Marker | undefined,
    sheet: Sheet,
): Box | undefined {
    const point = ({ col, colOff, row, rowOff }: Marker) => ({
        x: sheetColumnsWidth(sheet, 0, col - 1) + colOff / EMU_PER_PX,
        y: sheetRowsHeight(sheet, 0, row - 1) + rowOff / EMU_PER_PX,
    });
    const size = sizeOf(anchor);
    if (anchor.local === 'twoCellAnchor') {
        if (!from || !to) return undefined;
        const [start, end] = [point(from), point(to)];
        return rounded({
            x: Math.min(start.x, end.x),
            y: Math.min(start.y, end.y),
            width: Math.abs(end.x - start.x),
            height: Math.abs(end.y - start.y),
        });
    }
    if (anchor.local === 'oneCellAnchor') return from && size && rounded({ ...point(from), ...size });
    const position = xmlChild(anchor, XDR_NS, 'pos');
    const x = emu(position && xmlAttr(position, '', 'x'));
    const y = emu(position && xmlAttr(position, '', 'y'));
    return x !== undefined && y !== undefined && size
        ? rounded({ x: x / EMU_PER_PX, y: y / EMU_PER_PX, ...size })
        : undefined;
}

function chartSheetBox(anchor: XmlElement): Box {
    return rounded({ x: 0, y: 0, ...(sizeOf(anchor) ?? CHART_SHEET_SIZE) });
}

function sizeOf(anchor: XmlElement): Pick<Box, 'width' | 'height'> | undefined {
    const ext = xmlChild(anchor, XDR_NS, 'ext');
    const cx = emu(ext && xmlAttr(ext, '', 'cx'));
    const cy = emu(ext && xmlAttr(ext, '', 'cy'));
    return cx === undefined || cy === undefined ? undefined : { width: cx / EMU_PER_PX, height: cy / EMU_PER_PX };
}

function rounded({ x, y, width, height }: Box): Box {
    return sheetChartBox({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
}

// An element's children, an mc:AlternateContent read as the branch this reader understands.
function elements(element: XmlElement): XmlElement[] {
    return xmlElements(element).flatMap((item) => (isAlternateContent(item) ? alternative(item) : [item]));
}
