import { FLAT_CHART_PAINT } from '@workspace/lib/charts';
import type { VectorElementPatch } from '@workspace/lib/vector';
import type { DrawingTheme } from '../../core/drawingml';
import { C_NS, R_NS } from '../../core/ooxml';
import { readChart } from '../../core/ooxml-chart';
import { type XmlElement, xmlElements } from '../../core/xml';
import { cachedBy, childOf, prefixedAttrOf } from './lookup';
import type { DeckWalk, Part } from './package';

// A graphic frame's chart: its c:chartSpace part through the core chart reader, from the caches, which hold every
// value, so none of the part's own relationships (workbook, user shapes, colours, style) is followed.

// The spec as the chart kind stores it, or what the reader names a chart it can't draw as the file does.
export type FrameChart = { chart: string } | { unsupported: { title: string; type: string } };

// Painted as a document's and a sheet's charts are, in Inter, unfilled as PowerPoint's plot area.
export const CHART_PAINT = {
    fill: FLAT_CHART_PAINT.background,
    fontFamily: FLAT_CHART_PAINT.fontFamily,
    color: FLAT_CHART_PAINT.color,
    strokeColor: FLAT_CHART_PAINT.strokeColor,
    strokeWidth: FLAT_CHART_PAINT.strokeWidth,
    strokeStyle: FLAT_CHART_PAINT.strokeStyle,
    roughness: FLAT_CHART_PAINT.roughness,
} satisfies VectorElementPatch;

const read = cachedBy<DrawingTheme, FrameChart>();

// The chart a:graphicData names through the relationships of the part it is in; none when the part is missing, of
// another type or doesn't parse. A part is read once for each colour map it is painted with, however many frames on
// however many slides name it.
export function frameChart(deck: DeckWalk, from: Part, data: XmlElement, colors: DrawingTheme): FrameChart | undefined {
    const reference = childOf(data, C_NS, 'chart');
    const root = deck.pkg.chart(from, reference && prefixedAttrOf(reference, R_NS, 'id'));
    return (
        root &&
        read(root, colors, () => {
            // Read again for every colour map a slide paints it with, so each read is charged its elements.
            deck.read(nodesIn(root));
            const answer = readChart(root, { theme: colors, data: 'cache' });
            return 'spec' in answer ? { chart: JSON.stringify(answer.spec) } : answer;
        })
    );
}

const counted = cachedBy<null, number>();

// A part's elements, counted once.
function nodesIn(root: XmlElement): number {
    return counted(root, null, () => {
        let nodes = 0;
        const open = [root];
        for (let element = open.pop(); element; element = open.pop()) {
            nodes++;
            for (const child of xmlElements(element)) open.push(child);
        }
        return nodes;
    });
}
