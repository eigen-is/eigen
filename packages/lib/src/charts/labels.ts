// A chart's lines of text: measured in the chart's font, ellipsized to their room, and kept from touching. Every
// part of the layout builds its labels here, such as the title, a legend entry, a tick or a slice's share, so they
// all draw in one font and color and collide by one rule.

import type { ChartLabel } from '../types/chart';
import { measureLabel } from '../vector/text-width';
import type { Context, Frame } from './context';

const ELLIPSIS = '…';

type Anchor = ChartLabel['anchor'];

export function label(
    ctx: Context,
    text: string,
    x: number,
    y: number,
    anchor: Anchor,
    options: { fontSize?: number; bold?: boolean; rotate?: number } = {},
): ChartLabel {
    return {
        text,
        x,
        y,
        anchor,
        fontFamily: ctx.fontFamily,
        fontSize: options.fontSize ?? ctx.fontSize,
        bold: options.bold ?? false,
        color: ctx.paint.color,
        rotate: options.rotate ?? 0,
    };
}

export function measure(ctx: Context, text: string, fontSize = ctx.fontSize, bold = false): number {
    return measureLabel(text, ctx.fontFamily, fontSize, bold);
}

// The text as is when it fits, else its longest prefix that fits with an ellipsis, else ''.
export function fit(ctx: Context, text: string, maxWidth: number, fontSize = ctx.fontSize, bold = false): string {
    if (measure(ctx, text, fontSize, bold) <= maxWidth) return text;
    const chars = Array.from(text);
    let width = measure(ctx, ELLIPSIS, fontSize, bold);
    let end = 0;
    while (end < chars.length) {
        width += measure(ctx, chars[end], fontSize, bold);
        if (width > maxWidth) break;
        end++;
    }
    const head = chars.slice(0, end).join('').trimEnd();
    return head === '' ? '' : head + ELLIPSIS;
}

// An upright label's line box at the chart's text size. A caller that measured the text already passes its width.
export function labelBox(ctx: Context, { text, x, y, anchor }: ChartLabel, width = measure(ctx, text)): Frame {
    const left = anchor === 'start' ? x : anchor === 'middle' ? x - width / 2 : x - width;
    return { left, top: y, right: left + width, bottom: y + ctx.lineHeight };
}

// Side by side two labels keep a gap apart, as the bar chart's ticks are spaced; stacked lines may meet.
export function touches(ctx: Context, a: Frame, b: Frame): boolean {
    return a.left < b.right + ctx.gap && b.left < a.right + ctx.gap && a.top < b.bottom && b.top < a.bottom;
}

// Each label in turn is kept when its box touches none kept before it, so of two that collide the first keeps its
// place. Callers rank their labels first, as Highcharts ranks its data labels.
export function keepUntouched(ctx: Context, ranked: { label: ChartLabel; box: Frame }[]): ChartLabel[] {
    const boxes: Frame[] = [];
    const kept: ChartLabel[] = [];
    for (const { label: placed, box } of ranked) {
        if (boxes.some((other) => touches(ctx, other, box))) continue;
        boxes.push(box);
        kept.push(placed);
    }
    return kept;
}

// Every other label hides until none touch, Vega's parity rule, keeping the one at `keep` (zero's, when the axis
// has it).
export function hideCrowded(ctx: Context, labels: ChartLabel[], keep: number): ChartLabel[] {
    let kept = labels;
    let at = keep;
    const crowded = () =>
        kept.some((next, i) => i > 0 && touches(ctx, labelBox(ctx, kept[i - 1]), labelBox(ctx, next)));
    while (kept.length > 1 && crowded()) {
        kept = kept.filter((_, i) => (i - at) % 2 === 0);
        at = Math.floor(at / 2);
    }
    return kept;
}
