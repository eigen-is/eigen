// Autofilter UI: the filter-range border and the per-column buttons, drawn inside every drawMain
// pass so freeze-region pinning and clipping match the cells underneath. Each button is painted in
// its filterOptions item's rect, the one the mousedown hit test reads too. The styling is Google
// Sheets': a bare strainer glyph when idle, a green wash on hover, and a filled green box with a
// funnel when the column has an active filter.

import { canvasColors } from './colors';
import { HALF_PIXEL, sheetToCanvasX, sheetToCanvasY } from './geometry';
import type { RenderPass } from './types';

// Filter-button glyphs (24×24 viewBox): the Google-style strainer (three
// shrinking lines) and the filled funnel. Created lazily — Path2D needs a DOM.
let filterGlyphs: { strainer: Path2D; funnel: Path2D } | undefined;
function getFilterGlyphs() {
    filterGlyphs ??= {
        strainer: new Path2D('M4 7h16M7 12h10M10 17h4'),
        funnel: new Path2D(
            'M18.14 4a1.5 1.5 0 0 1 1.16 2.44L14.7 12.15v6.4l-5.37-2.56v-3.96L4.5 6.31A1.5 1.5 0 0 1 5.76 4h12.38z',
        ),
    };
    return filterGlyphs;
}

export function drawFilterUI(pass: RenderPass) {
    const { sheetCtx, renderCtx, scrollWidth, scrollHeight, drawWidth, drawHeight, offsetLeft, offsetTop } = pass;
    const options = sheetCtx.filterOptions;
    if (options == null) return;

    const { appColor, mutedForeground, background, selectionHandle } = canvasColors(renderCtx.canvas);
    const glyphs = getFilterGlyphs();

    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(offsetLeft - 1, offsetTop - 1, drawWidth + 1, drawHeight + 1);
    renderCtx.clip();

    renderCtx.strokeStyle = selectionHandle;
    renderCtx.lineWidth = 1;
    renderCtx.strokeRect(
        sheetToCanvasX(options.left, scrollWidth, offsetLeft) - HALF_PIXEL,
        sheetToCanvasY(options.top, scrollHeight, offsetTop) - HALF_PIXEL,
        options.width + 1,
        options.height + 1,
    );

    for (const item of options.items) {
        if (
            item.left + item.width < scrollWidth ||
            item.left > scrollWidth + drawWidth ||
            item.top + item.height < scrollHeight ||
            item.top > scrollHeight + drawHeight
        ) {
            continue;
        }

        const bx = sheetToCanvasX(item.left, scrollWidth, offsetLeft);
        const by = sheetToCanvasY(item.top, scrollHeight, offsetTop);
        const active = sheetCtx.filter[item.col - options.startCol] != null;
        const hovered = sheetCtx.filterButtonHover === item.col;

        if (active) {
            // The box is opaque, so it covers any cell ink underneath.
            renderCtx.beginPath();
            renderCtx.roundRect(bx + HALF_PIXEL, by + HALF_PIXEL, item.width - 1, item.height - 1, 3);
            renderCtx.fillStyle = appColor;
            renderCtx.fill();
        } else if (hovered) {
            // The background first, then a 14% green wash. That is the canvas version of
            // --app-sheets-color-soft, because a canvas fillStyle can't parse color-mix().
            renderCtx.beginPath();
            renderCtx.roundRect(bx + HALF_PIXEL, by + HALF_PIXEL, item.width - 1, item.height - 1, 3);
            renderCtx.fillStyle = background;
            renderCtx.fill();
            renderCtx.save();
            renderCtx.globalAlpha = 0.14;
            renderCtx.fillStyle = appColor;
            renderCtx.fill();
            renderCtx.restore();
        }

        // The glyph is centered in the button. In a column at the 10px resize floor it is wider
        // than the button, but its ink still fits inside.
        renderCtx.save();
        if (active) {
            // A 13×13 funnel knocked out of the green box.
            renderCtx.translate(bx + (item.width - 13) / 2, by + (item.height - 13) / 2);
            renderCtx.scale(13 / 24, 13 / 24);
            renderCtx.fillStyle = background;
            renderCtx.fill(glyphs.funnel);
        } else {
            // A 12×12 strainer: green on hover, muted otherwise.
            renderCtx.translate(bx + (item.width - 12) / 2, by + (item.height - 12) / 2);
            renderCtx.scale(12 / 24, 12 / 24);
            renderCtx.strokeStyle = hovered ? appColor : mutedForeground;
            renderCtx.lineWidth = 2.5;
            renderCtx.lineCap = 'round';
            renderCtx.lineJoin = 'round';
            renderCtx.stroke(glyphs.strainer);
        }
        renderCtx.restore();
    }

    renderCtx.restore();
}
