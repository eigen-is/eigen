// A graphic frame's chart: its c:chartSpace part through the core chart reader, from the caches, which hold every
// value, so none of the part's own relationships (workbook, user shapes, colours, style) is followed. Its look is the
// one the core reader reads for every format, at the slide's scale.

import { FLAT_CHART_LOOK, newChartSpecParts } from '@workspace/lib/charts';
import type { ChartLook, ChartSpecPartKey } from '@workspace/lib/types/chart';
import type { XmlElement } from '../../core/xml';
import type { DrawingTheme } from '../../ooxml/drawingml';
import { C_NS, R_NS } from '../../ooxml/ooxml';
import type { ChartRead } from '../../ooxml/ooxml-chart';
import { chartCost, readChart, readChartPartLook } from '../../ooxml/ooxml-chart';
import type { Part } from '../../ooxml/opc';
import { affords, cachedBy, charge, childOf, prefixedAttrOf } from './lookup';
import type { DeckWalk } from './package';

// The spec's parts as the chart kind stores them with its look, or what the reader names a chart it can't draw as the
// file does.
export type FrameChart =
    | { parts: Record<ChartSpecPartKey, string>; look: Omit<ChartLook, 'seed'> }
    | Extract<ChartRead, { unsupported: unknown }>;

// A chart part paints no sketch, so a chart reads flat and solid; the reader reads the rest.
const SKETCH = { strokeStyle: FLAT_CHART_LOOK.strokeStyle, roughness: FLAT_CHART_LOOK.roughness };

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
            const look = readChartPartLook(root, { theme: colors, emuPerPx: 1 / deck.scale });
            return { parts: newChartSpecParts(answer.spec), look: { ...look, ...SKETCH } };
        })
    );
}
