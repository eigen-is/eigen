// A chart's legend: a swatch and a name per series, or per slice for a pie. Top and bottom wrap centered rows, left
// and right a column centered on the room left. Entries past the room are dropped rather than squeezing the plot away,
// and a "+N" after the last one kept counts them. The layout places it after the title and gives the plot what is left.

import type { ChartShape, ChartSpec } from '../types/chart';
import { serializeFill } from '../vector/fill';
import type { Context, Frame } from './context';
import { LABEL_SHARE } from './context';
import { fit, label, measure } from './labels';
import { outlineOf, rectangle } from './shapes';

export type LegendItem = { name: string; color: string };

export function placeLegend(
    ctx: Context,
    position: ChartSpec['legend']['position'],
    items: LegendItem[],
    frame: Frame,
): { shapes: ChartShape[]; frame: Frame } {
    const shapes: ChartShape[] = [];
    if (position === 'none' || items.length === 0) return { shapes, frame };
    const { lineHeight: lh, gap } = ctx;
    const swatch = ctx.fontSize * 0.8;
    const indent = swatch + ctx.fontSize * 0.4;
    const spacing = ctx.fontSize;
    const place = (item: LegendItem, index: number, text: string, x: number, top: number) => {
        const y = top + (lh - swatch) / 2;
        const fill = serializeFill({ type: 'solid', color: item.color, style: ctx.paint.fillStyle });
        const box = { x, y, width: swatch, height: swatch };
        shapes.push(rectangle(ctx, `legend:${index}`, box, outlineOf(ctx, item.color), fill));
        ctx.labels.push(label(ctx, text, x + indent, top, 'start'));
    };

    if (position === 'top' || position === 'bottom') {
        const room = frame.right - frame.left;
        const fitted = items.map((item) => fit(ctx, item.name, room - indent));
        const rows: number[][] = [[]];
        let rowWidth = 0;
        for (const [i, text] of fitted.entries()) {
            const itemWidth = indent + measure(ctx, text);
            const row = rows[rows.length - 1];
            if (row.length > 0 && rowWidth + spacing + itemWidth > room) {
                rows.push([i]);
                rowWidth = itemWidth;
            } else {
                row.push(i);
                rowWidth += (row.length > 1 ? spacing : 0) + itemWidth;
            }
        }
        const maxRows = Math.max(1, Math.floor(((frame.bottom - frame.top) * LABEL_SHARE) / lh));
        const kept = rows.slice(0, maxRows);
        const widthsOf = (row: number[], tail: string) => [
            ...row.map((i) => indent + measure(ctx, fitted[i])),
            ...(tail === '' ? [] : [measure(ctx, tail)]),
        ];
        const lineWidth = (widths: number[]) =>
            widths.reduce((sum, width) => sum + width, 0) + spacing * Math.max(0, widths.length - 1);
        const last = kept[kept.length - 1];
        const shown = () => kept.reduce((sum, row) => sum + row.length, 0);
        let more = kept.length < rows.length ? `+${items.length - shown()}` : '';
        while (more !== '' && last.length > 0 && lineWidth(widthsOf(last, more)) > room) {
            last.pop();
            more = `+${items.length - shown()}`;
        }
        const top = position === 'top' ? frame.top : frame.bottom - kept.length * lh;
        for (const [r, row] of kept.entries()) {
            const rowTop = top + r * lh;
            const tail = row === last ? more : '';
            const widths = widthsOf(row, tail);
            let x = (frame.left + frame.right) / 2 - lineWidth(widths) / 2;
            for (const [k, i] of row.entries()) {
                place(items[i], i, fitted[i], x, rowTop);
                x += widths[k] + spacing;
            }
            if (tail !== '') ctx.labels.push(label(ctx, tail, x, rowTop, 'start'));
        }
        const used = kept.length * lh + gap;
        return {
            shapes,
            frame: position === 'top' ? { ...frame, top: frame.top + used } : { ...frame, bottom: frame.bottom - used },
        };
    }

    const room = (frame.right - frame.left) * LABEL_SHARE - indent;
    const fitted = items.map((item) => fit(ctx, item.name, room));
    const fits = Math.max(0, Math.floor((frame.bottom - frame.top) / lh));
    const kept = items.length > fits ? items.slice(0, Math.max(0, fits - 1)) : items;
    const more = kept.length < items.length && fits > 0 ? `+${items.length - kept.length}` : '';
    const columnWidth = indent + Math.max(measure(ctx, more), ...fitted.map((text) => measure(ctx, text)));
    const top = (frame.top + frame.bottom - (kept.length + (more === '' ? 0 : 1)) * lh) / 2;
    const x = position === 'left' ? frame.left : frame.right - columnWidth;
    for (const [i, item] of kept.entries()) place(item, i, fitted[i], x, top + i * lh);
    if (more !== '') ctx.labels.push(label(ctx, more, x + indent, top + kept.length * lh, 'start'));
    const used = columnWidth + 2 * gap;
    return {
        shapes,
        frame: position === 'left' ? { ...frame, left: frame.left + used } : { ...frame, right: frame.right - used },
    };
}
