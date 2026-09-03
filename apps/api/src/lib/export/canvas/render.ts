import { backgroundCss } from '@workspace/lib/background';
import { escapeHtml } from '@workspace/lib/html';
import type { BackgroundFill } from '@workspace/lib/types/background';
import {
    DEFAULT_PADDING,
    isTransparentColor,
    type Layer,
    layerBoxCss,
    layerInnerHtml,
    type MediaResolver,
    orderByFractionalIndex,
    parseBackgroundFill,
    round,
    sceneBounds,
    sceneLayers,
    type VectorScene,
} from '@workspace/lib/vector';

// The canvas compositor: a page of sceneLayers as an HTML string, for the PDF export and the
// preview body. A layer carries the same box CSS the live canvas sets (layerBoxCss), so what a user
// sees is what prints. Worker-pure: no Mount, no preview cache, no DOM.
//
// A kind points at its own gradient with `fill="url(#g-<id>)"` / `stroke="url(#…)"` and clips an
// image with `clip-path="url(#…)"` — SVG ATTRIBUTES, never a CSS declaration. That is load-bearing
// on the export path: sanitize.ts rewrites every non-data url() found in a `style` attribute or a
// <style> block to `url()`, so a gradient moved into CSS would silently stop painting in the PDF.

const SVG_NS = 'http://www.w3.org/2000/svg';

// A page in SCENE units plus the offset that brings its top-left to (0,0): a frame is (0,0)-based
// so its origin is zero, a frameless drawing's content bounds start wherever the user drew.
export type CanvasPage = {
    width: number;
    height: number;
    originX: number;
    originY: number;
    background: BackgroundFill | null;
    layers: Layer[];
};

// The whole drawing as one page, or null when there is nothing to size a page from.
export function drawingPage(scene: VectorScene, resolveMedia: MediaResolver): CanvasPage | null {
    if (scene.elements.length === 0) return null;
    // byId feeds the derived elbow route, whose bends spill past the stored endpoints, to the bounds.
    const byId = new Map(scene.elements.map((el) => [el.id, el]));
    const bounds = sceneBounds(scene.elements, byId);
    return {
        width: round(bounds.maxX - bounds.minX + DEFAULT_PADDING * 2),
        height: round(bounds.maxY - bounds.minY + DEFAULT_PADDING * 2),
        originX: round(bounds.minX - DEFAULT_PADDING),
        originY: round(bounds.minY - DEFAULT_PADDING),
        background: sceneBackground(scene),
        layers: sceneLayers(scene, { resolveMedia }),
    };
}

// One page per frame, in deck order. A frame IS the page — 0,0-based and a fixed size — so unlike a
// drawing there is no content-bounds arithmetic and no origin offset; an element that overhangs is
// clipped by the page box, exactly as the live canvas clips it.
export function framePages(scene: VectorScene, resolveMedia: MediaResolver): CanvasPage[] {
    return orderByFractionalIndex(scene.frames).map((frame) => ({
        width: frame.width,
        height: frame.height,
        originX: 0,
        originY: 0,
        background: parseBackgroundFill(frame.background),
        layers: sceneLayers(scene, { frameId: frame.id, resolveMedia }),
    }));
}

// A page of the given box with nothing on it, for a caller that must produce a page even when the
// drawing has no bounds to size one from (the preview cache stores only a non-empty body, so an
// emptied drawing would otherwise keep serving the preview it had when it still had content).
export function emptyPage(scene: VectorScene, width: number, height: number): CanvasPage {
    return { width, height, originX: 0, originY: 0, background: sceneBackground(scene), layers: [] };
}

// The scene background is a colour token; 'transparent' is no paint at all, not a
// `background-color: transparent` declaration.
function sceneBackground(scene: VectorScene): BackgroundFill | null {
    return isTransparentColor(scene.meta.background) ? null : { type: 'solid', color: scene.meta.background };
}

// One page: a clipped box at `scale`, holding the scene at 1:1 with the whole thing scaled once. The
// resolver is only for a frame's IMAGE background — a drawing's background is a colour token, so
// those callers pass nothing.
export function renderCanvasPage(page: CanvasPage, scale: number, resolveMedia?: MediaResolver): string {
    const pageStyle = [
        'position:relative',
        'overflow:hidden',
        `width:${round(page.width * scale)}px`,
        `height:${round(page.height * scale)}px`,
        ...backgroundCss(page.background, resolveMedia),
    ];
    // scale first, then translate: the shift is expressed in scene units and rides the scale.
    const sceneStyle = [
        'position:absolute',
        'top:0',
        'left:0',
        `width:${round(page.width)}px`,
        `height:${round(page.height)}px`,
        // The scale is NOT rounded: the page box above is `width * scale`, so a 2-dp scale on an
        // awkward ratio (960 / 2870) would leave a gutter between the scene and the page edge.
        `transform:scale(${scale}) translate(${round(-page.originX)}px,${round(-page.originY)}px)`,
        'transform-origin:0 0',
    ];
    const body = page.layers.map(renderLayer).join('');
    return `<div class="canvas-page" style="${style(pageStyle)}"><div style="${style(sceneStyle)}">${body}</div></div>`;
}

// The same page in the fit box every SCREEN consumer scales it in — the HTML export document, the
// lightbox and the drive hero. The box carries the page's composed size as custom properties so one
// rule set (`.page-fit`, packages/ui/src/styles/globals.css, mirrored by the export document's own
// CSS) fits a 16:9 slide and a drawing of any ratio the same way.
export function renderFittedPage(page: CanvasPage, scale: number, resolveMedia?: MediaResolver): string {
    const width = round(page.width * scale);
    const height = round(page.height * scale);
    return `<div class="page-fit" style="--page-w:${width}px;--page-ar:${width}/${height}">${renderCanvasPage(page, scale, resolveMedia)}</div>`;
}

function renderLayer(layer: Layer): string {
    const layerStyle = [
        'position:absolute',
        'top:0',
        'left:0',
        ...Object.entries(layerBoxCss(layer)).map(([property, value]) => `${property}:${value}`),
    ];
    // Rich text IS the layer's body (layerInnerHtml wraps it in its styled div); everything else is
    // an unpositioned kind fragment that needs an SVG viewport, overflow-visible because roughjs
    // overshoots its box and an elbow route spills past it. min-*-px: a horizontal arrow's box is
    // 0 high, and a zero-extent SVG viewport disables rendering entirely (SVG 2 §8.2).
    // layerInnerHtml deliberately omits the <p> margin reset a standalone SVG carries: the PDF
    // wrapper's `* { margin: 0 }` and the app's Tailwind preflight each already supply one.
    const inner = layerInnerHtml(layer.content);
    const body =
        'svg' in layer.content
            ? `<svg xmlns="${SVG_NS}" overflow="visible" style="${style([
                  'position:absolute',
                  'top:0',
                  'left:0',
                  'width:100%',
                  'height:100%',
                  'min-width:1px',
                  'min-height:1px',
                  'overflow:visible',
              ])}">${inner}</svg>`
            : inner;
    return `<div style="${style(layerStyle)}">${body}</div>`;
}

function style(declarations: string[]): string {
    return escapeHtml(declarations.join(';'));
}
