// Autofilter UI: the filter-range border and the per-column buttons, drawn
// inside every drawMain pass so freeze-region pinning and clipping match the
// cells underneath. Geometry comes from filterOptions.items plus the shared
// button constants — the same values the mousedown hit-test uses. Colors
// resolve from the theme tokens the HTML buttons used (border-primary /
// bg-background / bg-primary).

import { FILTER_BUTTON_HEIGHT, FILTER_BUTTON_WIDTH } from '../modules/filter';
import type { RenderPass } from './types';

// Filter-button glyphs (24×24 viewBox): lucide chevron-down and the filled
// funnel the HTML buttons used. Created lazily — Path2D needs a DOM.
let filterGlyphs: { chevron: Path2D; funnel: Path2D } | undefined;
function getFilterGlyphs() {
    filterGlyphs ??= {
        chevron: new Path2D('m6 9 6 6 6-6'),
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
    | { primary: string; primaryForeground: string; background: string; selectionHandle: string }
    | undefined;

export function drawFilterUI(pass: RenderPass) {
    const { sheetCtx, renderCtx, scrollWidth, scrollHeight, drawWidth, drawHeight, offsetLeft, offsetTop } = pass;
    const options = sheetCtx.filterOptions;
    if (options == null) return;

    if (cachedColors == null) {
        const style = getComputedStyle(renderCtx.canvas);
        cachedColors = {
            primary: style.getPropertyValue('--primary').trim(),
            primaryForeground: style.getPropertyValue('--primary-foreground').trim(),
            background: style.getPropertyValue('--background').trim(),
            selectionHandle: style.getPropertyValue('--selection-handle').trim(),
        };
        queueMicrotask(() => {
            cachedColors = undefined;
        });
    }
    const { primary, primaryForeground, background, selectionHandle } = cachedColors;
    const glyphs = getFilterGlyphs();

    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(offsetLeft - 1, offsetTop - 1, drawWidth + 1, drawHeight + 1);
    renderCtx.clip();

    // Sheet coords map to the same -1-shifted canvas space the cells use.
    const toCanvasX = (x: number) => x - scrollWidth + offsetLeft - 1;
    const toCanvasY = (y: number) => y - scrollHeight + offsetTop - 1;

    // Range border (was the border-selection-handle overlay div)
    renderCtx.strokeStyle = selectionHandle;
    renderCtx.lineWidth = 1;
    renderCtx.strokeRect(
        toCanvasX(options.left) - 0.5,
        toCanvasY(options.top) - 0.5,
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

        const bx = toCanvasX(item.left);
        const by = toCanvasY(item.top);
        const active = sheetCtx.filter[item.col - options.startCol] != null;
        const hovered = sheetCtx.filterButtonHover === item.col;
        const filled = active || hovered;

        renderCtx.beginPath();
        renderCtx.roundRect(bx + 0.5, by + 0.5, FILTER_BUTTON_WIDTH - 1, FILTER_BUTTON_HEIGHT - 1, 2);
        renderCtx.fillStyle = filled ? primary : background;
        renderCtx.fill();
        renderCtx.strokeStyle = primary;
        renderCtx.lineWidth = 1;
        renderCtx.stroke();

        const glyphColor = filled ? primaryForeground : primary;
        if (active) {
            // 13×13 funnel, centered (the active-filter glyph)
            renderCtx.save();
            renderCtx.translate(bx + (FILTER_BUTTON_WIDTH - 13) / 2, by + (FILTER_BUTTON_HEIGHT - 13) / 2);
            renderCtx.scale(13 / 24, 13 / 24);
            renderCtx.fillStyle = glyphColor;
            renderCtx.fill(glyphs.funnel);
            renderCtx.restore();
        } else {
            // 12×12 chevron-down, centered (lucide stroke conventions)
            renderCtx.save();
            renderCtx.translate(bx + (FILTER_BUTTON_WIDTH - 12) / 2, by + (FILTER_BUTTON_HEIGHT - 12) / 2);
            renderCtx.scale(12 / 24, 12 / 24);
            renderCtx.strokeStyle = glyphColor;
            renderCtx.lineWidth = 2;
            renderCtx.lineCap = 'round';
            renderCtx.lineJoin = 'round';
            renderCtx.stroke(glyphs.chevron);
            renderCtx.restore();
        }
    }

    renderCtx.restore();
}
