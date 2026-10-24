// Convert to shapes: a chart unpacked into the plain elements its painter draws. It reads the painter's own
// layout (chartLayout), so each shape converts to exactly what drew it; the labels become rich-text boxes.

import { textToParagraphHtml } from '../../core/html';
import type { ChartLabel } from '../../types/chart';
import { serializeFill, TRANSPARENT_COLOR, TRANSPARENT_FILL } from '../fill';
import { getFontMetrics, getLineHeightPx } from '../font-metrics';
import { boxCenter, rotatePoint } from '../geometry';
import { normalizeAngle } from '../outline';
import { measureLabel } from '../text-width';
import type { TextAlign, VectorChartElement, VectorElement, VectorRichTextElement } from '../types';
import { DEFAULT_CORNERS, DEFAULT_RICHTEXT_PROPS } from '../types';
import { chartLayout } from './chart-render';

// measureLabel ignores kerning and guesses outside Latin-1, so a box cut to it exactly could wrap its line.
const LABEL_SLACK_EMS = 0.5;
const ANCHOR_SHARE: Record<ChartLabel['anchor'], number> = { start: 0, middle: 0.5, end: 1 };
const ANCHOR_ALIGN: Record<ChartLabel['anchor'], TextAlign> = { start: 'left', middle: 'center', end: 'right' };

// [] for a chart that draws its placeholder. Ids stay the layout's `${chartId}:…` placeholders for the
// writer to replace; seeds are kept, so the jitter and the hatches don't reroll.
export function chartToElements(chart: VectorChartElement): VectorElement[] {
    const layout = chartLayout(chart);
    if (!layout) return [];
    const local = [...layout.shapes, ...layout.labels.map((label, i) => labelBox(chart, label, i))];
    const center = boxCenter(chart);
    return local.map((el) => {
        const at = rotatePoint(
            { x: chart.x + el.x + el.width / 2, y: chart.y + el.y + el.height / 2 },
            center,
            chart.angle,
        );
        return {
            ...el,
            x: at.x - el.width / 2,
            y: at.y - el.height / 2,
            angle: normalizeAngle(el.angle + chart.angle),
            frameId: chart.frameId,
            opacity: (el.opacity * chart.opacity) / 100,
        };
    });
}

// A label turns about its anchor at the line's top, an element about its box center: the box is laid out
// unturned from the anchor, then its center is turned about the anchor.
function labelBox(chart: VectorChartElement, label: ChartLabel, i: number): VectorRichTextElement {
    const { fontFamily, fontSize, bold } = label;
    const width = measureLabel(label.text, fontFamily, fontSize, bold) + LABEL_SLACK_EMS * fontSize;
    const height = getLineHeightPx(fontFamily, fontSize);
    const center = rotatePoint(
        { x: label.x + (0.5 - ANCHOR_SHARE[label.anchor]) * width, y: label.y + height / 2 },
        label,
        label.rotate,
    );
    return {
        ...DEFAULT_RICHTEXT_PROPS,
        id: `${chart.id}:label:${i}`,
        type: 'richtext',
        x: center.x - width / 2,
        y: center.y - height / 2,
        width,
        height,
        angle: label.rotate,
        index: '',
        frameId: '',
        commentCardIds: '',
        opacity: 100,
        strokeColor: TRANSPARENT_COLOR,
        strokeWidth: chart.strokeWidth,
        strokeStyle: 'solid',
        roughness: chart.roughness,
        seed: chart.seed,
        html: textToParagraphHtml(label.text),
        fill: serializeFill(TRANSPARENT_FILL),
        corners: DEFAULT_CORNERS,
        fontFamily,
        fontSize,
        fontWeight: bold ? 'bold' : 'normal',
        textAlign: ANCHOR_ALIGN[label.anchor],
        color: label.color,
        // The font's own line height, so the baseline sits where the painter's SVG text put it.
        lineHeight: getFontMetrics(fontFamily).lineHeight,
        padding: 0,
    };
}
