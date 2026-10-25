// A worksheet's or a chart sheet's drawing: the anchors that place its charts and pictures over the grid, each read into
// a SheetChart or a SheetImage. Shapes are not read. A chart's refs may name any sheet, so the drawings are placed once
// every sheet has its id.

import { newSheetChartSpecParts } from '@workspace/lib/charts';
import type { Sheet, SheetChart, SheetImage } from '@workspace/lib/sheets';
import {
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    sheetColumnsWidth,
    sheetFloatingBox,
    sheetRowsHeight,
} from '@workspace/lib/sheets';
import type { ChartSpec, SheetChartSpecParts } from '@workspace/lib/types/chart';
import { CHART_SPEC_PART_KEYS } from '@workspace/lib/types/chart';
import { generateKeyBetween, normalizeAngle } from '@workspace/lib/vector';
import type { XmlElement } from '../../core/xml';
import { hasXmlName, xmlAttr, xmlChild, xmlTrimmedText } from '../../core/xml';
import type { CountedWarningCode } from '../../document/transform/protocol';
import type { Box, DrawingTheme } from '../../ooxml/drawingml';
import { anchoredBox, blipEmbeds, DEGREE } from '../../ooxml/drawingml';
import { A_NS, alternativeFor, C_NS, EMU_PER_PX, emu, ooxmlElements, R_NS, SML_NS, XDR_NS } from '../../ooxml/ooxml';
import { chartCost, chartPart, readChart, readChartPartLook } from '../../ooxml/ooxml-chart';
import type { OoxmlPackage, Relationship } from '../../ooxml/opc';
import { optional, relTarget } from '../../ooxml/opc';
import type { MediaPart } from '../image-types';
import { pictureMediaPart } from '../image-types';

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
        anchors: ooxmlElements(root, alternative).filter(
            (element) => element.ns === XDR_NS && ANCHORS.has(element.local),
        ),
        rels: optional(() => pkg.relationships(path)) ?? new Map(),
    };
}

export type DrawingContext = {
    pkg: OoxmlPackage;
    theme: DrawingTheme;
    // A sheet's id by the name the workbook writes, lower-cased.
    sheetIds: ReadonlyMap<string, string>;
    // A chart's elements, or an anchor's tracks, charged only when the budget left covers them: one it can't is left out.
    spend(count: number): boolean;
    // Throws past the output budget, which a chart's parts' text counts toward: enough charts refuse the workbook.
    charge(cells: number, text: number): void;
    // A picture part's media file, null past the import's media budget (import/image-types.ts).
    mediaName(part: MediaPart): string | undefined | null;
    lost(code: CountedWarningCode): void;
};

// Each drawing's charts and pictures onto its sheet, painted in file order, the charts as chart-0, chart-1, … across the
// workbook. Left out and counted: a chart the reader can't draw, a part missing or damaged, a place no anchor names, one
// past the budget, and each of Excel 2016's charts; a picture of a type a sheet doesn't draw, its part missing or past
// the media budget. A chart part is read once however many anchors name it, and each chart costs its elements and
// points (chartCost) and every anchor the tracks walked to place it. A chart sheet shows its chart alone.
export function placeDrawings(drawings: Drawing[], context: DrawingContext): void {
    const costs = new Map<XmlElement, number>();
    const specs = new Map<XmlElement, ChartSpec | undefined>();
    let placed = 0;
    for (const { sheet, chartSheet, anchors, rels } of drawings) {
        for (const rel of rels.values()) if (rel.type.endsWith('/chartEx')) context.lost('charts-dropped');
        let index: string | null = null;
        const paint = () => {
            index = generateKeyBetween(index, null);
            return index;
        };
        for (const anchor of anchors) {
            const from = markerOf(xmlChild(anchor, XDR_NS, 'from'));
            const to = markerOf(xmlChild(anchor, XDR_NS, 'to'));
            const tracks = chartSheet ? 0 : [from, to].reduce((sum, at) => sum + (at ? at.col + at.row : 0), 0);
            const picture = chartSheet
                ? undefined
                : ooxmlElements(anchor, alternative).find((element) => hasXmlName(element, XDR_NS, 'pic'));
            if (picture) {
                const image = pictureOf(picture, rels, context, () => anchorBox(anchor, from, to, sheet), tracks);
                if (image) (sheet.images ??= {})[image.id] = { ...image, index: paint() };
                else context.lost('images-dropped');
                continue;
            }
            // The c:chart the anchor's graphic frame shows.
            const frame = ooxmlElements(anchor, alternative).find((element) =>
                hasXmlName(element, XDR_NS, 'graphicFrame'),
            );
            const graphic = frame && xmlChild(frame, A_NS, 'graphic');
            const data = graphic && xmlChild(graphic, A_NS, 'graphicData');
            const reference = data && xmlChild(data, C_NS, 'chart');
            if (!reference) continue;
            const root = chartPart(context.pkg, rels, xmlAttr(reference, R_NS, 'id'), 'xl/charts/');
            if (root && !costs.has(root)) costs.set(root, chartCost(root));
            const cost = root && costs.get(root);
            const spec = root && cost !== undefined && context.spend(cost + tracks) ? specOf(root) : undefined;
            const box =
                spec &&
                (chartSheet
                    ? rounded({ x: 0, y: 0, ...(sizeOf(anchor) ?? CHART_SHEET_SIZE) })
                    : anchorBox(anchor, from, to, sheet));
            if (!root || !spec || !box) {
                context.lost('charts-dropped');
                continue;
            }
            const parts = newSheetChartSpecParts(spec);
            context.charge(0, partsText(parts));
            const look = readChartPartLook(root, { theme: context.theme, emuPerPx: EMU_PER_PX, host: 'xlsx' });
            const chart: SheetChart = { id: `chart-${placed++}`, index: paint(), ...box, ...look, ...parts };
            (sheet.charts ??= {})[chart.id] = chart;
            if (chartSheet) break;
        }
    }

    // By the cells it names, else by its caches.
    function specOf(root: XmlElement): ChartSpec | undefined {
        if (specs.has(root)) return specs.get(root);
        const ranges = (name: string) => context.sheetIds.get(name.toLowerCase());
        const read = readChart(root, { theme: context.theme, data: { ranges } });
        const spec = 'spec' in read ? read.spec : undefined;
        specs.set(root, spec);
        return spec;
    }
}

// The text a chart's parts spell out in the snapshot: each part's, and each entry's key and text.
export function partsText(parts: SheetChartSpecParts): number {
    let length = 0;
    for (const key of CHART_SPEC_PART_KEYS) {
        const part = parts[key];
        if (typeof part === 'string') length += part.length;
        else for (const [entry, text] of Object.entries(part)) length += entry.length + text.length;
    }
    return length;
}

// A picture over its box, turned by its a:xfrm's rot as Eigen turns it, clockwise. Excel and LibreOffice anchor a
// picture turned sideways over its box turned a quarter, so its own box is that one turned back (anchoredBox). Its
// part is its svgBlip's, else its blip's.
function pictureOf(
    picture: XmlElement,
    rels: ReadonlyMap<string, Relationship>,
    context: DrawingContext,
    place: () => Box | undefined,
    tracks: number,
): Omit<SheetImage, 'index'> | undefined {
    const fill = xmlChild(picture, XDR_NS, 'blipFill');
    const [svg, raster] = blipEmbeds(fill && xmlChild(fill, A_NS, 'blip'));
    const part = pictureMediaPart(context.pkg, rels, svg, 'xl/') ?? pictureMediaPart(context.pkg, rels, raster, 'xl/');
    if (!part || !context.spend(tracks + 1)) return undefined;
    const anchored = place();
    const mediaName = anchored && context.mediaName(part);
    if (!anchored || !mediaName) return undefined;
    const properties = xmlChild(picture, XDR_NS, 'spPr');
    const xfrm = properties && xmlChild(properties, A_NS, 'xfrm');
    const angle = normalizeAngle(Number(xfrm && xmlAttr(xfrm, '', 'rot')) / DEGREE || 0);
    const { x, y, width, height } = rounded(anchoredBox(anchored, angle));
    return { id: crypto.randomUUID(), x, y, width, height, ...(angle !== 0 && { angle }), mediaName };
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

function sizeOf(anchor: XmlElement): Pick<Box, 'width' | 'height'> | undefined {
    const ext = xmlChild(anchor, XDR_NS, 'ext');
    const cx = emu(ext && xmlAttr(ext, '', 'cx'));
    const cy = emu(ext && xmlAttr(ext, '', 'cy'));
    return cx === undefined || cy === undefined ? undefined : { width: cx / EMU_PER_PX, height: cy / EMU_PER_PX };
}

function rounded({ x, y, width, height }: Box): Box {
    return sheetFloatingBox({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
    });
}
