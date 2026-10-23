// A chart's look: one reader for a doc's and a sheet's stored fields, and the one map from any chart's look to the
// painter's ChartPaint, so a chart paints the same wherever it lives.

import type { ChartLook, ChartPaint } from '../types/chart';
import { parseFill, serializeFill, TRANSPARENT_FILL } from '../vector/fill';
import { color, fillField, oneOf, roughness, seed, strokeWidth } from '../vector/kinds/read-fields';
import { STROKE_STYLES } from '../vector/types';

// Google's flat look on the page's own background, which a chart that stores no look draws. strokeColor draws the
// baseline at full strength and the gridlines faint, so a mid gray gives a clear baseline and Google's light
// gridlines. strokeWidth is every line's; 2 is Google's series line width, so a line series reads at page scale. Solid
// marks draw no outline.
export const FLAT_CHART_LOOK: ChartLook = {
    fill: serializeFill(TRANSPARENT_FILL),
    color: '#202124',
    strokeColor: '#757575',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    seed: 1,
};

// Through the canvas reader's validators, any peer or paste having written them. A missing field reads flat; a
// missing fill is no background, as the flat look has none.
export function readChartLook(src: Record<string, unknown>): ChartLook {
    return {
        fill: fillField(src['fill']),
        color: color(src['color'], FLAT_CHART_LOOK.color),
        strokeColor: color(src['strokeColor'], FLAT_CHART_LOOK.strokeColor),
        strokeWidth: strokeWidth(src['strokeWidth'], FLAT_CHART_LOOK.strokeWidth),
        strokeStyle: oneOf(src['strokeStyle'], STROKE_STYLES, FLAT_CHART_LOOK.strokeStyle),
        roughness: roughness(src['roughness'], FLAT_CHART_LOOK.roughness),
        seed: seed(src['seed'], FLAT_CHART_LOOK.seed),
    };
}

// The fill's paint is the background and its hatch style the marks'; the stroke draws axes and gridlines.
export function chartPaintOf(look: ChartLook): ChartPaint {
    return {
        color: look.color,
        background: look.fill,
        strokeColor: look.strokeColor,
        strokeWidth: look.strokeWidth,
        strokeStyle: look.strokeStyle,
        roughness: look.roughness,
        seed: look.seed,
        fillStyle: parseFill(look.fill).style,
    };
}
