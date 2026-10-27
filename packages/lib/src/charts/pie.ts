// A pie chart's plot: one slice per positive value of its first series, clockwise from 12 o'clock, each labeled with
// its name and share just outside the arc. There are no leader lines, so the radius shrinks until every label fits the
// frame, and a label that would touch another is left out, the biggest slices keeping theirs. The layout calls it with
// the frame the title and legend leave.

import type { ChartLabel, ChartShape, ChartSpec } from '../types/chart';
import { serializeFill } from '../vector/fill';
import { normalizeAngle } from '../vector/outline';
import { DEG_TO_RAD } from '../vector/points';
import type { Context, Frame } from './context';
import { LABEL_SHARE } from './context';
import { chartColor, chartPointColor } from './defaults';
import { fit, keepUntouched, label, labelBox, measure } from './labels';
import { outlineOf, pieSlice } from './shapes';

// A thin slice goes unlabeled rather than colliding.
const MIN_LABELED_SLICE = 0.05;

// Null when the frame is too small for a pie.
export function layoutPie(
    ctx: Context,
    spec: ChartSpec,
    id: string,
    categories: string[],
    values: (number | null)[],
    frame: Frame,
): ChartShape[] | null {
    const { lineHeight: lh, gap } = ctx;
    const total = values.reduce<number>((sum, value) => sum + (value !== null && value > 0 ? value : 0), 0);
    const full = Math.min(frame.right - frame.left, frame.bottom - frame.top) / 2;
    if (full < ctx.fontSize) return null;
    const cx = (frame.left + frame.right) / 2;
    const cy = (frame.top + frame.bottom) / 2;

    let swept = 0;
    const slices = values.flatMap((value, c) => {
        if (value === null || value <= 0) return [];
        const share = value / total;
        const start = normalizeAngle(270 + swept * 360);
        swept += share;
        return [{ c, share, start, sweep: share * 360 }];
    });

    const labelRoom = (frame.right - frame.left) * LABEL_SHARE;
    const placed = slices
        .filter((slice) => slice.share >= MIN_LABELED_SLICE)
        .map((slice) => {
            const percent = `${Math.round(slice.share * 100)}%`;
            const name = categories[slice.c];
            const text = fit(ctx, name === '' ? percent : `${name} ${percent}`, labelRoom);
            const mid = (slice.start + slice.sweep / 2) * DEG_TO_RAD;
            const cos = Math.cos(mid);
            const sin = Math.sin(mid);
            const anchor: ChartLabel['anchor'] = cos > 0.2 ? 'start' : cos < -0.2 ? 'end' : 'middle';
            const width = measure(ctx, text);
            const left = anchor === 'start' ? 0 : anchor === 'middle' ? -width / 2 : -width;
            return { text, share: slice.share, cos, sin, anchor, left, right: left + width };
        })
        .filter((entry) => entry.text !== '');

    // Each label edge is linear in the radius, so each frame side caps it directly.
    let radius = full;
    for (const entry of placed) {
        const top = -lh / 2 + (lh / 2) * entry.sin;
        radius = Math.min(
            radius,
            cap(-entry.left, -entry.cos, cx - frame.left) - gap,
            cap(entry.right, entry.cos, frame.right - cx) - gap,
            cap(-top, -entry.sin, cy - frame.top) - gap,
            cap(top + lh, entry.sin, frame.bottom - cy) - gap,
        );
    }
    const labeled = radius >= full / 2;
    if (!labeled) radius = full;

    const shapes = slices.map((slice) => {
        const color = sliceColor(spec, id, slice.c);
        const fill = serializeFill({ type: 'solid', color, style: ctx.paint.fillStyle });
        const box = { x: cx - radius, y: cy - radius, width: 2 * radius, height: 2 * radius };
        return pieSlice(ctx, `slice:0:${slice.c}`, box, outlineOf(ctx, color), fill, slice.start, slice.sweep);
    });
    if (labeled) {
        // Largest slices first, as Highcharts ranks its data labels.
        const ranked = [...placed]
            .sort((a, b) => b.share - a.share)
            .map((entry) => {
                const x = cx + (radius + gap) * entry.cos;
                const y = cy + (radius + gap) * entry.sin - lh / 2 + (lh / 2) * entry.sin;
                const sliceLabel = label(ctx, entry.text, x, y, entry.anchor);
                return { label: sliceLabel, box: labelBox(ctx, sliceLabel, entry.right - entry.left) };
            });
        ctx.labels.push(...keepUntouched(ctx, ranked));
    }
    return shapes;
}

// A slice's own color, else the palette's at its index; the legend's swatches read the same.
export function sliceColor(spec: ChartSpec, id: string, index: number): string {
    return chartPointColor(spec, id, index) ?? chartColor(index);
}

// The largest distance t from the center that keeps a label edge, `offset + t * direction` toward one
// frame side, within that side's `limit`.
function cap(offset: number, direction: number, limit: number): number {
    if (direction > 1e-9) return (limit - offset) / direction;
    return offset <= limit ? Number.POSITIVE_INFINITY : 0;
}
