// One frame of the sheet canvas: the panes of cells, the row and column headers and the freeze lines,
// painted in one order. drawFrame paints a frame whole, as after an edit or a resize. After a scroll alone,
// scrollFrame moves the pixels of each pane that scrolled and repaints only what came into view, plus a
// thin band at the pane's ends. Every painter places the sheet on the canvas by a plain offset, and the
// panes paint apart, each pane of cells clipped to its own rect, so both give the same picture.

import { Canvas } from '../canvas';
import type { Context } from '../context';
import type { Freezen } from '../types';

export type ScrollPos = { scrollLeft: number; scrollTop: number };

// A rect on the canvas, end exclusive. A layer's boxes are in CSS pixels; what a scroll moves and repaints
// is in device pixels, so it lands on whole pixels.
export type Box = { x0: number; y0: number; x1: number; y1: number };

// One painter call: a pane of cells, or a header strip, over `box`, showing the sheet from `left` and `top`.
// `paint` is where its pixels land: the painters draw one pixel above and left of `box`, and a header stops
// one pixel short of the cells. A frozen pane follows the scroll on one axis or on none.
type Layer = {
    kind: 'cells' | 'columnHeader' | 'rowHeader';
    box: Box;
    paint: Box;
    left: number;
    top: number;
    followsX: boolean;
    followsY: boolean;
};

// What a scroll does to the frame: the pixels to copy, each from `shiftX`, `shiftY` device pixels away,
// then the boxes to repaint.
export type ScrollPlan = { copies: { box: Box; shiftX: number; shiftY: number }[]; stale: Box[] };

// A painter draws its first and last row or column a little differently, such as a header's fill that
// reaches two pixels further. So a scroll moves only the pixels this far inside a pane's ends, and
// repaints the rest. In CSS pixels.
const EDGE = 4;

// A repaint draws this far past the box it fixes, so the cells whose border or fill reaches into it are
// drawn too. A column letter is centered on its column and can be wider than a narrow one, such as XFD,
// so the column headers draw further. In CSS pixels.
const MARGIN = 8;
const HEADER_MARGIN = 32;

export function drawFrame(canvas: HTMLCanvasElement, ctx: Context, scroll: ScrollPos, freeze: Freezen | undefined) {
    const renderCtx = canvas.getContext('2d');
    if (!renderCtx) return;
    const painter = new Canvas(canvas, ctx);
    renderCtx.clearRect(0, 0, canvas.width, canvas.height);
    for (const layer of frameLayers(ctx, scroll, freeze)) {
        paintLayer(painter, renderCtx, ctx, layer, layer.box);
    }
    drawFreezeLines(painter, ctx, freeze);
}

// Moves the frame drawn at `from` to `to` and repaints what that leaves out of date. Returns false when
// the frame must be drawn whole instead.
export function scrollFrame(
    canvas: HTMLCanvasElement,
    ctx: Context,
    freeze: Freezen | undefined,
    from: ScrollPos,
    to: ScrollPos,
): boolean {
    const renderCtx = canvas.getContext('2d');
    const plan = planScroll(ctx, freeze, from, to, canvas.width, canvas.height);
    if (!renderCtx || !plan) return false;
    for (const { box, shiftX, shiftY } of plan.copies) {
        copyBox(renderCtx, canvas, box, shiftX, shiftY);
    }
    const painter = new Canvas(canvas, ctx);
    const layers = frameLayers(ctx, to, freeze);
    for (const box of plan.stale) {
        repaint(painter, renderCtx, ctx, freeze, layers, box);
    }
    return true;
}

// The copies and repaints of a scroll from `from` to `to` on a canvas of `width` by `height` device pixels,
// or undefined when the frame must be drawn whole: the scroll moved by part of a device pixel, or so far
// that most of the canvas would be repainted anyway.
export function planScroll(
    ctx: Context,
    freeze: Freezen | undefined,
    from: ScrollPos,
    to: ScrollPos,
    width: number,
    height: number,
): ScrollPlan | undefined {
    const dpr = ctx.devicePixelRatio;
    const dx = (to.scrollLeft - from.scrollLeft) * dpr;
    const dy = (to.scrollTop - from.scrollTop) * dpr;
    if (!isWholePixel(dx) || !isWholePixel(dy)) return undefined;
    if (Math.abs(dx) > width / 2 || Math.abs(dy) > height / 2) return undefined;

    const bounds = { x0: 0, y0: 0, x1: width, y1: height };
    const edge = Math.ceil(EDGE * dpr);
    const plan: ScrollPlan = { copies: [], stale: [] };
    for (const layer of frameLayers(ctx, to, freeze)) {
        const shiftX = layer.followsX ? Math.round(dx) : 0;
        const shiftY = layer.followsY ? Math.round(dy) : 0;
        if (shiftX === 0 && shiftY === 0) continue;
        const area = intersect(coveredPixels(layer.paint, dpr), bounds);
        if (!area) continue;
        // A pixel the layer shares with its neighbour, at a fractional pixel ratio, is repainted, never
        // copied: two layers would each copy it. Only the ends across the scroll differ from the pane's
        // middle; along its sides a moved pixel comes from the same column or row of the same pane, and
        // the freeze lines look alike all along.
        const whole = intersect(wholePixels(layer.paint, dpr), bounds);
        const inside = whole && shrink(whole, shiftX ? edge : 0, shiftY ? edge : 0, bounds);
        const kept = inside && intersect(inside, translate(inside, -shiftX, -shiftY));
        if (kept) plan.copies.push({ box: kept, shiftX, shiftY });
        plan.stale.push(...subtract(area, kept));
    }
    return plan;
}

// The frame's painter calls, in paint order: the main pane, the frozen rows, the frozen columns and their
// corner, then the column headers and the row headers. Each band of columns or rows has where it starts on
// the canvas, how long it is, the sheet position it shows there, and whether it follows the scroll.
function frameLayers(ctx: Context, scroll: ScrollPos, freeze: Freezen | undefined): Layer[] {
    const rows = freeze?.horizontal?.freezenhorizontaldata;
    const cols = freeze?.vertical?.freezenverticaldata;
    const { rowHeaderWidth, columnHeaderHeight } = ctx;
    const [width, height] = ctx.tableContentSize;
    const { frozenWidth, frozenHeight } = frozenSize(freeze);

    const colBands = [
        { at: rowHeaderWidth + frozenWidth, size: width, sheet: scroll.scrollLeft + frozenWidth, follows: true },
    ];
    if (cols) colBands.push({ at: rowHeaderWidth, size: cols.pos, sheet: cols.scroll, follows: false });
    const rowBands = [
        { at: columnHeaderHeight + frozenHeight, size: height, sheet: scroll.scrollTop + frozenHeight, follows: true },
    ];
    if (rows) rowBands.push({ at: columnHeaderHeight, size: rows.pos, sheet: rows.scroll, follows: false });

    const layers: Layer[] = [];
    for (const col of colBands) {
        for (const row of rowBands) {
            const box = { x0: col.at, y0: row.at, x1: col.at + col.size, y1: row.at + row.size };
            layers.push({
                kind: 'cells',
                box,
                paint: translate(box, -1, -1),
                left: col.sheet,
                top: row.sheet,
                followsX: col.follows,
                followsY: row.follows,
            });
        }
    }
    for (const col of colBands) {
        layers.push({
            kind: 'columnHeader',
            box: { x0: col.at, y0: 0, x1: col.at + col.size, y1: columnHeaderHeight },
            paint: { x0: col.at - 1, y0: 0, x1: col.at + col.size - 1, y1: columnHeaderHeight - 1 },
            left: col.sheet,
            top: 0,
            followsX: col.follows,
            followsY: false,
        });
    }
    for (const row of rowBands) {
        layers.push({
            kind: 'rowHeader',
            box: { x0: 0, y0: row.at, x1: rowHeaderWidth, y1: row.at + row.size },
            paint: { x0: 0, y0: row.at - 1, x1: rowHeaderWidth - 1, y1: row.at + row.size - 1 },
            left: 0,
            top: row.sheet,
            followsX: false,
            followsY: row.follows,
        });
    }
    return layers;
}

// How far the frozen columns and rows reach on the canvas past the headers.
function frozenSize(freeze: Freezen | undefined) {
    const rows = freeze?.horizontal?.freezenhorizontaldata;
    const cols = freeze?.vertical?.freezenverticaldata;
    return { frozenWidth: cols ? cols.pos - cols.scroll : 0, frozenHeight: rows ? rows.pos - rows.scroll : 0 };
}

// Paints the part of a layer that falls in `part`, a box inside the layer's own, in CSS pixels.
function paintLayer(painter: Canvas, renderCtx: CanvasRenderingContext2D, ctx: Context, layer: Layer, part: Box) {
    const { box, paint } = layer;
    const left = layer.left + part.x0 - box.x0;
    const top = layer.top + part.y0 - box.y0;
    const width = part.x1 - part.x0;
    const height = part.y1 - part.y0;
    if (layer.kind === 'columnHeader') {
        painter.drawColumnHeader(left, width, part.x0);
        return;
    }
    if (layer.kind === 'rowHeader') {
        painter.drawRowHeader(top, height, part.y0);
        return;
    }
    // A pane keeps its paint inside its own box, so the text or merge of a frozen pane stops at the freeze line.
    const dpr = ctx.devicePixelRatio;
    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(paint.x0 * dpr, paint.y0 * dpr, (paint.x1 - paint.x0) * dpr, (paint.y1 - paint.y0) * dpr);
    renderCtx.clip();
    painter.drawMain({
        scrollWidth: left,
        scrollHeight: top,
        drawWidth: width,
        drawHeight: height,
        offsetLeft: part.x0,
        offsetTop: part.y0,
    });
    renderCtx.restore();
}

function drawFreezeLines(painter: Canvas, ctx: Context, freeze: Freezen | undefined) {
    if (!freeze?.horizontal && !freeze?.vertical) return;
    const { frozenWidth, frozenHeight } = frozenSize(freeze);
    painter.drawFreezeLine({
        horizontalTop: freeze.horizontal ? frozenHeight + ctx.columnHeaderHeight - 2 : undefined,
        verticalLeft: freeze.vertical ? frozenWidth + ctx.rowHeaderWidth - 2 : undefined,
    });
}

// Copies the pixels of `source` that lie `shift` away into `box`, all in device pixels. 'copy' writes
// transparent pixels too, such as the cleared space past the last column.
function copyBox(
    renderCtx: CanvasRenderingContext2D,
    source: HTMLCanvasElement,
    box: Box,
    shiftX: number,
    shiftY: number,
) {
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(box.x0, box.y0, w, h);
    renderCtx.clip();
    renderCtx.globalCompositeOperation = 'copy';
    renderCtx.drawImage(source, box.x0 + shiftX, box.y0 + shiftY, w, h, box.x0, box.y0, w, h);
    renderCtx.restore();
}

// Paints `box`, in device pixels, as drawFrame would: cleared, then every layer that reaches it, in order.
// Each layer is drawn a margin past the box, so the parts it draws differently at the ends of a partial
// paint fall outside it. Skia antialiases a glyph or a rounded stroke that the clip cuts a shade
// differently at the cut; the next whole frame paints over that.
function repaint(
    painter: Canvas,
    renderCtx: CanvasRenderingContext2D,
    ctx: Context,
    freeze: Freezen | undefined,
    layers: Layer[],
    box: Box,
) {
    const dpr = ctx.devicePixelRatio;
    const reach = (margin: number) => ({
        x0: box.x0 / dpr - margin,
        y0: box.y0 / dpr - margin,
        x1: box.x1 / dpr + margin,
        y1: box.y1 / dpr + margin,
    });
    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    renderCtx.clip();
    renderCtx.clearRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    for (const layer of layers) {
        const part = intersect(layer.box, reach(layer.kind === 'columnHeader' ? HEADER_MARGIN : MARGIN));
        if (part) paintLayer(painter, renderCtx, ctx, layer, part);
    }
    drawFreezeLines(painter, ctx, freeze);
    renderCtx.restore();
}

function isWholePixel(n: number) {
    return Math.abs(n - Math.round(n)) < 1e-3;
}

// The device pixels a CSS box touches, and those it covers whole. They differ only at a fractional pixel
// ratio, where two boxes that meet share a pixel.
function coveredPixels(box: Box, dpr: number): Box {
    return {
        x0: Math.floor(box.x0 * dpr),
        y0: Math.floor(box.y0 * dpr),
        x1: Math.ceil(box.x1 * dpr),
        y1: Math.ceil(box.y1 * dpr),
    };
}

function wholePixels(box: Box, dpr: number): Box {
    return {
        x0: Math.ceil(box.x0 * dpr),
        y0: Math.ceil(box.y0 * dpr),
        x1: Math.floor(box.x1 * dpr),
        y1: Math.floor(box.y1 * dpr),
    };
}

function intersect(a: Box, b: Box): Box | undefined {
    const box = {
        x0: Math.max(a.x0, b.x0),
        y0: Math.max(a.y0, b.y0),
        x1: Math.min(a.x1, b.x1),
        y1: Math.min(a.y1, b.y1),
    };
    return box.x0 < box.x1 && box.y0 < box.y1 ? box : undefined;
}

function translate(box: Box, x: number, y: number): Box {
    return { x0: box.x0 + x, y0: box.y0 + y, x1: box.x1 + x, y1: box.y1 + y };
}

// Shrinks a box by `byX` at its left and right and `byY` at its top and bottom, except on a side that lies
// on the canvas edge: a pane runs on past it, so its pixels there are like those in its middle.
function shrink(box: Box, byX: number, byY: number, bounds: Box): Box | undefined {
    return intersect(
        {
            x0: box.x0 <= bounds.x0 ? box.x0 : box.x0 + byX,
            y0: box.y0 <= bounds.y0 ? box.y0 : box.y0 + byY,
            x1: box.x1 >= bounds.x1 ? box.x1 : box.x1 - byX,
            y1: box.y1 >= bounds.y1 ? box.y1 : box.y1 - byY,
        },
        bounds,
    );
}

// The parts of `outer` that `hole` leaves, as up to four boxes: above, below, left and right of it.
function subtract(outer: Box, hole: Box | undefined): Box[] {
    if (!hole) return [outer];
    const parts = [
        { x0: outer.x0, y0: outer.y0, x1: outer.x1, y1: hole.y0 },
        { x0: outer.x0, y0: hole.y1, x1: outer.x1, y1: outer.y1 },
        { x0: outer.x0, y0: hole.y0, x1: hole.x0, y1: hole.y1 },
        { x0: hole.x1, y0: hole.y0, x1: outer.x1, y1: hole.y1 },
    ];
    return parts.filter((part) => part.x0 < part.x1 && part.y0 < part.y1);
}
