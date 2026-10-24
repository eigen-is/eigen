import { FLAT_CHART_LOOK, newChartSpecParts } from '@workspace/lib/charts';
import type { ChartSpecPartKey } from '@workspace/lib/types/chart';
import type { VectorElementPatch } from '@workspace/lib/vector';
import type { XmlElement } from '../../core/xml';
import type { DrawingTheme } from '../../ooxml/drawingml';
import { A_NS, C_NS, R_NS } from '../../ooxml/ooxml';
import type { ChartRead } from '../../ooxml/ooxml-chart';
import { chartColors, chartCost, readChart } from '../../ooxml/ooxml-chart';
import type { Part } from '../../ooxml/opc';
import { colorOf, mutedColor, textColorOf } from './inherit';
import { affords, cachedBy, charge, childOf, prefixedAttrOf } from './lookup';
import type { DeckWalk } from './package';

// A graphic frame's chart: its c:chartSpace part through the core chart reader, from the caches, which hold every
// value, so none of the part's own relationships (workbook, user shapes, colours, style) is followed.

// The spec's parts as the chart kind stores them with the colours its text and axes take, or what the reader names a
// chart it can't draw as the file does.
export type FrameChart =
    | { parts: Record<ChartSpecPartKey, string>; color: string; strokeColor: string }
    | Extract<ChartRead, { unsupported: unknown }>;

// Painted as a document's and a sheet's charts are, unfilled as PowerPoint's plot area; the font is the spec's.
export const CHART_PAINT = {
    fill: FLAT_CHART_LOOK.fill,
    strokeWidth: FLAT_CHART_LOOK.strokeWidth,
    strokeStyle: FLAT_CHART_LOOK.strokeStyle,
    roughness: FLAT_CHART_LOOK.roughness,
} satisfies VectorElementPatch;

const read = cachedBy<DrawingTheme, FrameChart | undefined>();
// Counted once per part, however many colour maps it is read in.
const costs = cachedBy<null, number>();

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
            const cost = costs(root, null, () => chartCost(root));
            if (!affords(cost)) return undefined;
            charge(cost);
            const answer = readChart(root, { theme: colors, data: 'cache' });
            if (!('spec' in answer)) return answer;
            const color = textColorIn(root, colors);
            return { parts: newChartSpecParts(answer.spec), color, strokeColor: mutedColor(color) };
        })
    );
}

// c:txPr's colour, else tx1, through the chart's colour map as readChart paints its series.
function textColorIn(root: XmlElement, slide: DrawingTheme): string {
    const colors = chartColors(root, slide);
    const properties = childOf(root, C_NS, 'txPr');
    const paragraph = properties && childOf(properties, A_NS, 'p');
    const pPr = paragraph && childOf(paragraph, A_NS, 'pPr');
    const defRPr = pPr && childOf(pPr, A_NS, 'defRPr');
    return colorOf(defRPr && childOf(defRPr, A_NS, 'solidFill'), colors) ?? textColorOf(colors);
}
