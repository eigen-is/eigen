// The state one chart layout carries from step to step: the box, the paint, the text size scaled to the box, and the
// labels each step adds. layoutChart makes one per chart, and each part of the layout, such as the legend or the plot,
// reads its sizes from it and pushes its labels onto it.

import type { ChartBox, ChartLabel, ChartPaint } from '../types/chart';
import { getLineHeightPx } from '../vector/font-metrics';

// Base text size as a share of the box's shorter side, as Google's charts scale theirs.
const TEXT_SCALE = 0.035;
const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 64;

// Share of the room a label column, a legend or turned category labels may take before they ellipsize or drop.
export const LABEL_SHARE = 0.3;

export type Frame = { left: number; top: number; right: number; bottom: number };

export type Context = {
    id: string;
    paint: ChartPaint;
    fontFamily: string;
    width: number;
    height: number;
    fontSize: number;
    lineHeight: number;
    pad: number;
    gap: number;
    labels: ChartLabel[];
};

export function chartContext({ id, width: w, height: h, paint }: ChartBox, fontFamily: string): Context {
    const width = Math.max(0, w);
    const height = Math.max(0, h);
    const fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, TEXT_SCALE * Math.min(width, height)));
    return {
        id,
        paint,
        fontFamily,
        width,
        height,
        fontSize,
        lineHeight: getLineHeightPx(fontFamily, fontSize),
        pad: fontSize,
        gap: fontSize / 2,
        labels: [],
    };
}
