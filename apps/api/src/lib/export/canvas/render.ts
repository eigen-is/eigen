import { backgroundCss } from '@workspace/lib/background';
import { escapeHtml } from '@workspace/lib/html';
import type { BackgroundFill } from '@workspace/lib/types/background';
import {
    isTransparentColor,
    type Layer,
    layerInnerHtml,
    type MediaResolver,
    sceneBounds,
    sceneLayers,
    type VectorScene,
} from '@workspace/lib/vector';

// The canvas compositor: a page of sceneLayers as an HTML string, for the PDF export and the
// preview body. The live canvas (packages/ui element-layer.tsx) places a layer with exactly this
// box — left/top 0 plus `translate(x,y) rotate(a)`, whose default transform-origin is the box
// centre — so what a user sees is what prints. Worker-pure: no Mount, no preview cache, no DOM.
//
// The page scales as a WHOLE (one transform on the scene wrapper) rather than re-unitising each
// length, because a layer's body is authored in scene pixels by packages/lib — a roughjs path in
// the element's local frame, or richTextCssText's `font-size:20px`. Phase 0 measured a scene
// `transform: scale()` as correct in WeasyPrint.
//
// A kind points at its own gradient with `fill="url(#g-<id>)"` / `stroke="url(#…)"` and clips an
// image with `clip-path="url(#…)"` — SVG ATTRIBUTES, never a CSS declaration. That is load-bearing
// on the export path: sanitize.ts rewrites every non-data url() found in a `style` attribute or a
// <style> block to `url()`, so a gradient moved into CSS would silently stop painting in the PDF.

const SVG_NS = 'http://www.w3.org/2000/svg';

// The margin sceneToSvg leaves around a drawing, so a page and a standalone SVG frame it alike.
// sceneBounds is the geometric union of the element boxes and the derived elbow routes; it does not
// inflate for roughjs's overshoot, which is what this padding absorbs (the layers are
// overflow-visible either way, so an overshoot past the page is clipped by the page, not lost).
const PAGE_PADDING = 10;

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

// The whole drawing as one page, or null when there is nothing to size a page from. (Frames get
// their own feeder with the slides shell; a drawing has no frames today — spec D7.)
export function drawingPage(scene: VectorScene, opts: { resolveMedia?: MediaResolver } = {}): CanvasPage | null {
    if (scene.elements.length === 0) return null;
    // byId feeds the derived elbow route, whose bends spill past the stored endpoints, to the bounds.
    const byId = new Map(scene.elements.map((el) => [el.id, el]));
    const bounds = sceneBounds(scene.elements, byId);
    return {
        width: round(bounds.maxX - bounds.minX + PAGE_PADDING * 2),
        height: round(bounds.maxY - bounds.minY + PAGE_PADDING * 2),
        originX: round(bounds.minX - PAGE_PADDING),
        originY: round(bounds.minY - PAGE_PADDING),
        // The scene background is a colour token; 'transparent' is no paint at all, not a
        // `background-color: transparent` declaration.
        background: isTransparentColor(scene.meta.background) ? null : { type: 'solid', color: scene.meta.background },
        layers: sceneLayers(scene, { resolveMedia: opts.resolveMedia }),
    };
}

// One page: a clipped box at `scale`, holding the scene at 1:1 with the whole thing scaled once.
export function renderCanvasPage(page: CanvasPage, scale: number): string {
    const pageStyle = [
        'position:relative',
        'overflow:hidden',
        `width:${round(page.width * scale)}px`,
        `height:${round(page.height * scale)}px`,
        ...backgroundCss(page.background),
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

function renderLayer(layer: Layer): string {
    const { box } = layer;
    const rotate = box.angle === 0 ? '' : ` rotate(${round(box.angle)}deg)`;
    const layerStyle = [
        'position:absolute',
        'top:0',
        'left:0',
        `width:${round(box.width)}px`,
        `height:${round(box.height)}px`,
        `transform:translate(${round(box.x)}px,${round(box.y)}px)${rotate}`,
    ];
    if (layer.opacity !== 100) layerStyle.push(`opacity:${round(layer.opacity / 100)}`);
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

// Every value in a generated declaration list is a number or a reader-validated colour token, so
// this escape is a no-op today — it is here so a future declaration can never break out of style="".
function style(declarations: string[]): string {
    return escapeHtml(declarations.join(';'));
}

function round(n: number): number {
    return Math.round(n * 100) / 100;
}
