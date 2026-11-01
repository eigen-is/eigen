// One frame of the sheet canvas: the panes of cells, the row and column headers and the freeze lines,
// painted in one order. drawFrame paints a frame whole, as after an edit or a resize. After a scroll
// alone, scrollFrame moves the pixels of each pane that scrolled and repaints only what came into view,
// plus a thin band at the pane's ends. Both give the same picture: every painter places the sheet on the
// canvas by a plain offset, and the panes paint apart from each other, each pane of cells clipped to its
// own rect. Only an edge pixel of a glyph or a rounded stroke that a repaint cuts can come out a shade off.

import { Canvas } from '../canvas';
import type { Context } from '../context';
import type { Freezen } from '../types';

export type ScrollPos = { scrollLeft: number; scrollTop: number };

// A rect on the canvas, end exclusive. A layer's rects are in CSS pixels; what a scroll moves and repaints
// is in device pixels, so it lands on whole pixels.
type Rect = { x0: number; y0: number; x1: number; y1: number };

// One painter call: a pane of cells, or a header strip, over `rect`, showing the sheet from `left` and
// `top`. `paint` is where its pixels land: the painters draw one pixel above and left of `rect`, and a
// header stops one pixel short of the cells. A frozen pane follows the scroll on one axis or on none.
type Layer = {
    kind: 'cells' | 'columnHeader' | 'rowHeader';
    rect: Rect;
    paint: Rect;
    left: number;
    top: number;
    followsX: boolean;
    followsY: boolean;
};

// A painter draws its first and last row or column a little differently, such as a header's fill that
// reaches two pixels further. So a scroll moves only the pixels this far inside a pane's ends, and
// repaints the rest. In CSS pixels.
const EDGE = 4;

// A repaint draws this far past the area it fixes, so the cells whose border or fill reaches into that
// area are drawn too. A column letter is centered on its column and can be wider than a narrow one, such
// as XFD, so the column headers draw further. In CSS pixels.
const MARGIN = 8;
const HEADER_MARGIN = 32;

export function drawFrame(canvas: HTMLCanvasElement, ctx: Context, scroll: ScrollPos, freeze: Freezen | undefined) {
    const g = canvas.getContext('2d');
    if (!g) return;
    const tc = new Canvas(canvas, ctx);
    g.clearRect(0, 0, canvas.width, canvas.height);
    for (const layer of frameLayers(ctx, scroll, freeze)) {
        paintLayer(tc, g, ctx, layer, layer.rect);
    }
    drawFreezeLines(tc, ctx, freeze);
}

// Moves the frame drawn at `from` to `to` and repaints what that leaves out of date. Returns false when
// the frame must be drawn whole instead: the scroll moved by part of a device pixel, or so far that most
// of the canvas would be repainted anyway.
export function scrollFrame(
    canvas: HTMLCanvasElement,
    ctx: Context,
    freeze: Freezen | undefined,
    from: ScrollPos,
    to: ScrollPos,
): boolean {
    const g = canvas.getContext('2d');
    if (!g) return false;
    const dpr = ctx.devicePixelRatio;
    const dx = (to.scrollLeft - from.scrollLeft) * dpr;
    const dy = (to.scrollTop - from.scrollTop) * dpr;
    if (!isWholePixel(dx) || !isWholePixel(dy)) return false;
    if (Math.abs(dx) > canvas.width / 2 || Math.abs(dy) > canvas.height / 2) return false;

    const bounds = { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height };
    const edge = Math.ceil(EDGE * dpr);
    const layers = frameLayers(ctx, to, freeze);
    const stale: Rect[] = [];
    for (const layer of layers) {
        const shiftX = layer.followsX ? Math.round(dx) : 0;
        const shiftY = layer.followsY ? Math.round(dy) : 0;
        if (shiftX === 0 && shiftY === 0) continue;
        const area = intersect(toDevice(layer.paint, dpr), bounds);
        if (!area) continue;
        // Only the ends across the scroll differ from the pane's middle. Along its sides, a moved pixel
        // comes from the same column or row of the same pane, and the freeze lines look alike all along.
        const inside = shrink(area, shiftX ? edge : 0, shiftY ? edge : 0, bounds);
        const kept = inside && intersect(inside, translate(inside, -shiftX, -shiftY));
        if (kept) copyRect(g, canvas, kept, shiftX, shiftY);
        stale.push(...subtract(area, kept));
    }

    const tc = new Canvas(canvas, ctx);
    for (const rect of stale) {
        repaint(tc, g, ctx, freeze, layers, rect);
    }
    return true;
}

// A run of columns or rows on the canvas: where it starts, how long it is, the sheet position it shows
// there, and whether it follows the scroll.
type Band = { at: number; size: number; sheet: number; follows: boolean };

// The frame's painter calls, in paint order: the main pane, the frozen rows, the frozen columns and their
// corner, then the column headers and the row headers. Each frozen band starts where its freeze put it.
function frameLayers(ctx: Context, scroll: ScrollPos, freeze: Freezen | undefined): Layer[] {
    const rows = freeze?.horizontal?.freezenhorizontaldata;
    const cols = freeze?.vertical?.freezenverticaldata;
    const { rowHeaderWidth, columnHeaderHeight } = ctx;
    const [width, height] = ctx.tableContentSize;
    const frozenWidth = cols ? cols.pos - cols.scroll : 0;
    const frozenHeight = rows ? rows.pos - rows.scroll : 0;

    const colBands: Band[] = [
        { at: rowHeaderWidth + frozenWidth, size: width, sheet: scroll.scrollLeft + frozenWidth, follows: true },
    ];
    if (cols) colBands.push({ at: rowHeaderWidth, size: cols.pos, sheet: cols.scroll, follows: false });
    const rowBands: Band[] = [
        { at: columnHeaderHeight + frozenHeight, size: height, sheet: scroll.scrollTop + frozenHeight, follows: true },
    ];
    if (rows) rowBands.push({ at: columnHeaderHeight, size: rows.pos, sheet: rows.scroll, follows: false });

    const layers: Layer[] = [];
    for (const col of colBands) {
        for (const row of rowBands) layers.push(cellsLayer(col, row));
    }
    for (const col of colBands) layers.push(columnHeaderLayer(col, columnHeaderHeight));
    for (const row of rowBands) layers.push(rowHeaderLayer(row, rowHeaderWidth));
    return layers;
}

function cellsLayer(col: Band, row: Band): Layer {
    const rect = { x0: col.at, y0: row.at, x1: col.at + col.size, y1: row.at + row.size };
    return {
        kind: 'cells',
        rect,
        paint: translate(rect, -1, -1),
        left: col.sheet,
        top: row.sheet,
        followsX: col.follows,
        followsY: row.follows,
    };
}

function columnHeaderLayer(col: Band, height: number): Layer {
    return {
        kind: 'columnHeader',
        rect: { x0: col.at, y0: 0, x1: col.at + col.size, y1: height },
        paint: { x0: col.at - 1, y0: 0, x1: col.at + col.size - 1, y1: height - 1 },
        left: col.sheet,
        top: 0,
        followsX: col.follows,
        followsY: false,
    };
}

function rowHeaderLayer(row: Band, width: number): Layer {
    return {
        kind: 'rowHeader',
        rect: { x0: 0, y0: row.at, x1: width, y1: row.at + row.size },
        paint: { x0: 0, y0: row.at - 1, x1: width - 1, y1: row.at + row.size - 1 },
        left: 0,
        top: row.sheet,
        followsX: false,
        followsY: row.follows,
    };
}

// Paints the part of a layer that falls in `part`, a rect inside the layer's own, in CSS pixels.
function paintLayer(tc: Canvas, g: CanvasRenderingContext2D, ctx: Context, layer: Layer, part: Rect) {
    const { rect, paint } = layer;
    const left = layer.left + part.x0 - rect.x0;
    const top = layer.top + part.y0 - rect.y0;
    const width = part.x1 - part.x0;
    const height = part.y1 - part.y0;
    if (layer.kind === 'columnHeader') {
        tc.drawColumnHeader(left, width, part.x0);
        return;
    }
    if (layer.kind === 'rowHeader') {
        tc.drawRowHeader(top, height, part.y0);
        return;
    }
    // A pane keeps its paint inside its own rect, so the text or merge of a frozen pane stops at the freeze line.
    const dpr = ctx.devicePixelRatio;
    g.save();
    g.beginPath();
    g.rect(paint.x0 * dpr, paint.y0 * dpr, (paint.x1 - paint.x0) * dpr, (paint.y1 - paint.y0) * dpr);
    g.clip();
    tc.drawMain({
        scrollWidth: left,
        scrollHeight: top,
        drawWidth: width,
        drawHeight: height,
        offsetLeft: part.x0,
        offsetTop: part.y0,
    });
    g.restore();
}

function drawFreezeLines(tc: Canvas, ctx: Context, freeze: Freezen | undefined) {
    const rows = freeze?.horizontal?.freezenhorizontaldata;
    const cols = freeze?.vertical?.freezenverticaldata;
    if (!rows && !cols) return;
    tc.drawFreezeLine({
        horizontalTop: rows ? rows.pos - rows.scroll + ctx.columnHeaderHeight - 2 : undefined,
        verticalLeft: cols ? cols.pos - cols.scroll + ctx.rowHeaderWidth - 2 : undefined,
    });
}

// Copies the pixels of `source` that lie `shift` away into `rect` of `g`, all in device pixels. 'copy'
// writes transparent pixels too, such as the cleared space past the last column.
function copyRect(g: CanvasRenderingContext2D, source: HTMLCanvasElement, rect: Rect, shiftX: number, shiftY: number) {
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    g.save();
    g.beginPath();
    g.rect(rect.x0, rect.y0, w, h);
    g.clip();
    g.globalCompositeOperation = 'copy';
    g.drawImage(source, rect.x0 + shiftX, rect.y0 + shiftY, w, h, rect.x0, rect.y0, w, h);
    g.restore();
}

// Paints `rect`, in device pixels, as drawFrame would: cleared, then every layer that reaches it, in order.
// Each layer is drawn a margin past the rect, so the parts it draws differently at the ends of a partial
// paint fall outside it. Skia antialiases a glyph or a rounded stroke that the clip cuts a shade
// differently at the cut; the next whole frame paints over that.
function repaint(
    tc: Canvas,
    g: CanvasRenderingContext2D,
    ctx: Context,
    freeze: Freezen | undefined,
    layers: Layer[],
    rect: Rect,
) {
    const dpr = ctx.devicePixelRatio;
    const reach = (margin: number) => ({
        x0: rect.x0 / dpr - margin,
        y0: rect.y0 / dpr - margin,
        x1: rect.x1 / dpr + margin,
        y1: rect.y1 / dpr + margin,
    });
    g.save();
    g.beginPath();
    g.rect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
    g.clip();
    g.clearRect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
    for (const layer of layers) {
        const part = intersect(layer.rect, reach(layer.kind === 'columnHeader' ? HEADER_MARGIN : MARGIN));
        if (part) paintLayer(tc, g, ctx, layer, part);
    }
    drawFreezeLines(tc, ctx, freeze);
    g.restore();
}

function isWholePixel(n: number) {
    return Math.abs(n - Math.round(n)) < 1e-3;
}

function toDevice(rect: Rect, dpr: number): Rect {
    return {
        x0: Math.floor(rect.x0 * dpr),
        y0: Math.floor(rect.y0 * dpr),
        x1: Math.ceil(rect.x1 * dpr),
        y1: Math.ceil(rect.y1 * dpr),
    };
}

function intersect(a: Rect, b: Rect): Rect | undefined {
    const rect = {
        x0: Math.max(a.x0, b.x0),
        y0: Math.max(a.y0, b.y0),
        x1: Math.min(a.x1, b.x1),
        y1: Math.min(a.y1, b.y1),
    };
    return rect.x0 < rect.x1 && rect.y0 < rect.y1 ? rect : undefined;
}

function translate(rect: Rect, x: number, y: number): Rect {
    return { x0: rect.x0 + x, y0: rect.y0 + y, x1: rect.x1 + x, y1: rect.y1 + y };
}

// Shrinks a rect by `byX` at its left and right and `byY` at its top and bottom, except on a side that lies
// on the canvas edge: a pane runs on past it, so its pixels there are like those in its middle.
function shrink(rect: Rect, byX: number, byY: number, bounds: Rect): Rect | undefined {
    return intersect(
        {
            x0: rect.x0 <= bounds.x0 ? rect.x0 : rect.x0 + byX,
            y0: rect.y0 <= bounds.y0 ? rect.y0 : rect.y0 + byY,
            x1: rect.x1 >= bounds.x1 ? rect.x1 : rect.x1 - byX,
            y1: rect.y1 >= bounds.y1 ? rect.y1 : rect.y1 - byY,
        },
        bounds,
    );
}

// The parts of `outer` that `hole` leaves, as up to four rects: above, below, left and right of it.
function subtract(outer: Rect, hole: Rect | undefined): Rect[] {
    if (!hole) return [outer];
    const parts = [
        { x0: outer.x0, y0: outer.y0, x1: outer.x1, y1: hole.y0 },
        { x0: outer.x0, y0: hole.y1, x1: outer.x1, y1: outer.y1 },
        { x0: outer.x0, y0: hole.y0, x1: hole.x0, y1: hole.y1 },
        { x0: hole.x1, y0: hole.y0, x1: outer.x1, y1: hole.y1 },
    ];
    return parts.filter((part) => part.x0 < part.x1 && part.y0 < part.y1);
}
