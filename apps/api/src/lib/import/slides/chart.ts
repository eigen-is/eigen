import { FLAT_CHART_PAINT, MAX_CHART_POINTS, MAX_CHART_SERIES } from '@workspace/lib/charts';
import type { VectorElementPatch } from '@workspace/lib/vector';
import type { DrawingTheme } from '../../core/drawingml';
import { A_NS, C_NS, R_NS } from '../../core/ooxml';
import { readChart } from '../../core/ooxml-chart';
import { type XmlElement, xmlAttr, xmlElements } from '../../core/xml';
import { colorOf, mutedColor, textColorOf } from './inherit';
import { affords, cachedBy, charge, childOf, prefixedAttrOf } from './lookup';
import type { DeckWalk, Part } from './package';

// A graphic frame's chart: its c:chartSpace part through the core chart reader, from the caches, which hold every
// value, so none of the part's own relationships (workbook, user shapes, colours, style) is followed.

// The spec as the chart kind stores it with the colours its text and axes take, or what the reader names a chart it
// can't draw as the file does.
export type FrameChart =
    | { chart: string; color: string; strokeColor: string }
    | { unsupported: { title: string; name: string } };

// Painted as a document's and a sheet's charts are, in Inter, unfilled as PowerPoint's plot area.
export const CHART_PAINT = {
    fill: FLAT_CHART_PAINT.background,
    fontFamily: FLAT_CHART_PAINT.fontFamily,
    strokeWidth: FLAT_CHART_PAINT.strokeWidth,
    strokeStyle: FLAT_CHART_PAINT.strokeStyle,
    roughness: FLAT_CHART_PAINT.roughness,
} satisfies VectorElementPatch;

const read = cachedBy<DrawingTheme, FrameChart | undefined>();

// The chart a:graphicData names through the relationships of the part it is in; none when the part is missing, of
// another type, doesn't parse or costs more work than the read has left. A part is read once for each colour map it is
// painted with, however many frames on however many slides name it.
export function frameChart(deck: DeckWalk, from: Part, data: XmlElement, colors: DrawingTheme): FrameChart | undefined {
    const reference = childOf(data, C_NS, 'chart');
    const root = deck.pkg.chart(from, reference && prefixedAttrOf(reference, R_NS, 'id'));
    return (
        root &&
        read(root, colors, () => {
            // Read again for every colour map a slide paints it with, so each read is charged its elements and points;
            // one the budget can't cover costs only its box, as a docx's chart past a cap does.
            const nodes = nodesIn(root);
            if (!affords(nodes)) return undefined;
            charge(nodes);
            const answer = readChart(root, { theme: colors, data: 'cache' });
            if (!('spec' in answer)) return { unsupported: { title: answer.unsupported.title, name: chartName(root) } };
            const color = textColorIn(root, colors);
            return { chart: JSON.stringify(answer.spec), color, strokeColor: mutedColor(color) };
        })
    );
}

// PowerPoint's names for a plot's kind, a bar plot's by its c:barDir and an of-pie plot's by its c:ofPieType.
const CHART_NAMES = new Map([
    ['areaChart', 'Area'],
    ['area3DChart', '3-D Area'],
    ['barChart col', 'Column'],
    ['barChart bar', 'Bar'],
    ['bar3DChart col', '3-D Column'],
    ['bar3DChart bar', '3-D Bar'],
    ['bubbleChart', 'Bubble'],
    ['doughnutChart', 'Doughnut'],
    ['lineChart', 'Line'],
    ['line3DChart', '3-D Line'],
    ['ofPieChart pie', 'Pie of pie'],
    ['ofPieChart bar', 'Bar of pie'],
    ['pieChart', 'Pie'],
    ['pie3DChart', '3-D Pie'],
    ['radarChart', 'Radar'],
    ['scatterChart', 'Scatter'],
    ['stockChart', 'Stock'],
    ['surfaceChart', 'Surface'],
    ['surface3DChart', '3-D Surface'],
]);

// What the box says was there: two plots are a combo, a plot of no kind PowerPoint names is none. The part's elements
// are charged already, so its plot area is scanned directly.
function chartName(root: XmlElement): string {
    const chart = childOf(root, C_NS, 'chart');
    const plotArea = chart && childOf(chart, C_NS, 'plotArea');
    const groups = plotArea
        ? xmlElements(plotArea).filter((element) => element.ns === C_NS && element.local.endsWith('Chart'))
        : [];
    if (groups.length > 1) return 'Combo';
    const [group] = groups;
    if (!group) return '';
    const option = childOf(group, C_NS, 'barDir') ?? childOf(group, C_NS, 'ofPieType');
    return CHART_NAMES.get(option ? `${group.local} ${xmlAttr(option, '', 'val')}` : group.local) ?? '';
}

// c:txPr's colour, else the slide's tx1.
function textColorIn(root: XmlElement, colors: DrawingTheme): string {
    const properties = childOf(root, C_NS, 'txPr');
    const paragraph = properties && childOf(properties, A_NS, 'p');
    const pPr = paragraph && childOf(paragraph, A_NS, 'pPr');
    const defRPr = pPr && childOf(pPr, A_NS, 'defRPr');
    return colorOf(defRPr && childOf(defRPr, A_NS, 'solidFill'), colors) ?? textColorOf(colors);
}

const counted = cachedBy<null, number>();

// A part's elements and the points readChart builds from them, counted once. A cache sizes its points by its
// c:ptCount, else by its last c:pt, whatever it holds, and the reader builds each series, the categories and the
// slices up to the longest before the spec's cap on all points together refuses them.
function nodesIn(root: XmlElement): number {
    return counted(root, null, () => {
        let nodes = 0;
        let series = 0;
        let longest = 0;
        const open = [root];
        for (let element = open.pop(); element; element = open.pop()) {
            nodes++;
            if (element.ns === C_NS && element.local === 'ser') series++;
            const points =
                element.ns !== C_NS
                    ? 0
                    : element.local === 'ptCount'
                      ? Number(xmlAttr(element, '', 'val'))
                      : element.local === 'pt'
                        ? Number(xmlAttr(element, '', 'idx')) + 1
                        : 0;
            if (points > longest) longest = Math.min(points, MAX_CHART_POINTS);
            for (const child of xmlElements(element)) open.push(child);
        }
        return nodes + (Math.min(series, MAX_CHART_SERIES) + 2) * longest;
    });
}
