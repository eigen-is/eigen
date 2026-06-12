// Autofilter UI: the filter-range border and the per-column buttons, drawn
// inside every drawMain pass so freeze-region pinning and clipping match the
// cells underneath. Geometry comes from filterOptions.items plus the shared
// button constants — the same values the mousedown hit-test uses. Button
// styling matches Google Sheets: a bare strainer glyph when idle, the sheets
// app green on hover (14% wash, mirroring the --app-sheets-color-soft mix,
// which canvas can't parse as color-mix()), and a filled green box with the
// funnel when the column has an active filter.

import { FILTER_BUTTON_HEIGHT, FILTER_BUTTON_WIDTH } from '../modules/filter';
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

// Theme colors resolved once per synchronous draw burst (a redraw is at most
// four freeze-region passes); the microtask flush makes a theme switch
// re-resolve on the next redraw, exactly as per-pass resolution did.
let cachedColors:
    | { appColor: string; mutedForeground: string; background: string; selectionHandle: string }
    | undefined;

export function drawFilterUI(pass: RenderPass) {
    const { sheetCtx, renderCtx, scrollWidth, scrollHeight, drawWidth, drawHeight, offsetLeft, offsetTop } = pass;
    const options = sheetCtx.filterOptions;
    if (options == null) return;

    if (cachedColors == null) {
        const style = getComputedStyle(renderCtx.canvas);
        cachedColors = {
            appColor: style.getPropertyValue('--app-sheets-color').trim(),
            mutedForeground: style.getPropertyValue('--muted-foreground').trim(),
            background: style.getPropertyValue('--background').trim(),
            selectionHandle: style.getPropertyValue('--selection-handle').trim(),
        };
        queueMicrotask(() => {
            cachedColors = undefined;
        });
    }
    const { appColor, mutedForeground, background, selectionHandle } = cachedColors;
    const glyphs = getFilterGlyphs();

    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(offsetLeft - 1, offsetTop - 1, drawWidth + 1, drawHeight + 1);
    renderCtx.clip();

    // Range border (was the border-selection-handle overlay div)
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
            item.left + FILTER_BUTTON_WIDTH < scrollWidth ||
            item.left > scrollWidth + drawWidth ||
            item.top + FILTER_BUTTON_HEIGHT < scrollHeight ||
            item.top > scrollHeight + drawHeight
        ) {
            continue;
        }

        const bx = sheetToCanvasX(item.left, scrollWidth, offsetLeft);
        const by = sheetToCanvasY(item.top, scrollHeight, offsetTop);
        const active = sheetCtx.filter[item.col - options.startCol] != null;
        const hovered = sheetCtx.filterButtonHover === item.col;

        if (active) {
            // Filled green box (opaque, covers any cell ink underneath)
            renderCtx.beginPath();
            renderCtx.roundRect(bx + HALF_PIXEL, by + HALF_PIXEL, FILTER_BUTTON_WIDTH - 1, FILTER_BUTTON_HEIGHT - 1, 3);
            renderCtx.fillStyle = appColor;
            renderCtx.fill();
        } else if (hovered) {
            // Background knockout first, then a 14% green wash — the canvas
            // equivalent of --app-sheets-color-soft (color-mix doesn't parse
            // as a canvas fillStyle).
            renderCtx.beginPath();
            renderCtx.roundRect(bx + HALF_PIXEL, by + HALF_PIXEL, FILTER_BUTTON_WIDTH - 1, FILTER_BUTTON_HEIGHT - 1, 3);
            renderCtx.fillStyle = background;
            renderCtx.fill();
            renderCtx.save();
            renderCtx.globalAlpha = 0.14;
            renderCtx.fillStyle = appColor;
            renderCtx.fill();
            renderCtx.restore();
        }

        if (active) {
            // 13×13 funnel knocked out of the green box, centered
            renderCtx.save();
            renderCtx.translate(bx + (FILTER_BUTTON_WIDTH - 13) / 2, by + (FILTER_BUTTON_HEIGHT - 13) / 2);
            renderCtx.scale(13 / 24, 13 / 24);
            renderCtx.fillStyle = background;
            renderCtx.fill(glyphs.funnel);
            renderCtx.restore();
        } else {
            // 12×12 strainer, centered; green on hover, muted otherwise
            renderCtx.save();
            renderCtx.translate(bx + (FILTER_BUTTON_WIDTH - 12) / 2, by + (FILTER_BUTTON_HEIGHT - 12) / 2);
            renderCtx.scale(12 / 24, 12 / 24);
            renderCtx.strokeStyle = hovered ? appColor : mutedForeground;
            renderCtx.lineWidth = 2.5;
            renderCtx.lineCap = 'round';
            renderCtx.lineJoin = 'round';
            renderCtx.stroke(glyphs.strainer);
            renderCtx.restore();
        }
    }

    renderCtx.restore();
}
