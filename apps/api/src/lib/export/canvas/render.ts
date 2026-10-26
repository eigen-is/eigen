// The canvas compositor: a page of scene layers as an HTML string, for the deck and drawing exports and their previews.
// A screen layer carries the box CSS the live canvas sets, a printed one the same box laid out where it prints, so
// what a user sees is what prints. It touches no Mount, preview cache or DOM. Each layer's gradient and clip
// references stay inside its own <svg>, because WeasyPrint resolves `url(#id)` only within one.

import { backgroundCss } from '@workspace/lib/background';
import { escapeHtml } from '@workspace/lib/html';
import type { BackgroundFill } from '@workspace/lib/types/background';
import type { Layer, MediaResolver, VectorScene } from '@workspace/lib/vector';
import {
    DEFAULT_PADDING,
    isTransparentColor,
    layerBoxCss,
    layerInnerHtml,
    layerPrintCss,
    orderByFractionalIndex,
    parseBackgroundFill,
    round,
    sceneBounds,
    sceneLayers,
} from '@workspace/lib/vector';
import { mediaNamesIn } from '../../document/media';

// The media a deck or drawing names: its images, and the frame backgrounds, which the scene keeps as stored JSON.
export function sceneMediaNames(scene: VectorScene): Set<string> {
    return mediaNamesIn([scene.elements, scene.frames.map((frame) => parseBackgroundFill(frame.background))]);
}

// A page in scene units plus the offset that brings its top-left to (0,0): a frame is (0,0)-based
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
        layers: sceneLayers(scene, { resolveMedia, byId }),
    };
}

// One page per frame, in deck order. A frame is the page, 0,0-based and the deck's size, so unlike a
// drawing there is no content-bounds arithmetic and no origin offset; an element that overhangs is
// clipped by the page box, exactly as the live canvas clips it.
export function framePages(scene: VectorScene, resolveMedia: MediaResolver): CanvasPage[] {
    // One map for the whole deck: it spans every element whatever page is being composed, so building
    // it per frame would cost the deck's element count once per slide.
    const byId = new Map(scene.elements.map((el) => [el.id, el]));
    return orderByFractionalIndex(scene.frames).map((frame) => ({
        width: frame.width,
        height: frame.height,
        originX: 0,
        originY: 0,
        background: parseBackgroundFill(frame.background),
        layers: sceneLayers(scene, { frameId: frame.id, resolveMedia, byId }),
    }));
}

// A page of the given box with nothing on it, for a caller that must produce a page even when the
// document has no content to size one from (the preview cache stores only a non-empty body, so an
// emptied document would otherwise keep serving the preview it had when it still had content). The
// background is the caller's: a drawing paints its scene color, a deck the frame default.
export function emptyPage(background: BackgroundFill | null, width: number, height: number): CanvasPage {
    return { width, height, originX: 0, originY: 0, background, layers: [] };
}

// The scene background is a color token; 'transparent' is no paint at all, not a
// `background-color: transparent` declaration.
export function sceneBackground(scene: VectorScene): BackgroundFill | null {
    return isTransparentColor(scene.meta.background) ? null : { type: 'solid', color: scene.meta.background };
}

// One page on screen: a clipped box at `scale`, holding the scene at 1:1 with the whole thing scaled
// once. The resolver is only for a frame's image background — a drawing's background is a color token,
// so those callers pass nothing.
export function renderCanvasPage(page: CanvasPage, scale: number, resolveMedia?: MediaResolver): string {
    // scale first, then translate: the shift is expressed in scene units and rides the scale.
    const sceneStyle = [
        'position:absolute',
        'top:0',
        'left:0',
        `width:${round(page.width)}px`,
        `height:${round(page.height)}px`,
        // The scale is not rounded: the page box above is `width * scale`, so a 2-dp scale on an
        // awkward ratio (960 / 2870) would leave a gutter between the scene and the page edge.
        `transform:scale(${scale}) translate(${round(-page.originX)}px,${round(-page.originY)}px)`,
        'transform-origin:0 0',
    ];
    const body = page.layers
        .map((layer) => renderLayer(layer, { top: '0', left: '0', ...layerBoxCss(layer) }))
        .join('');
    return `<div class="canvas-page" style="${style(pageStyle(page, scale, resolveMedia))}"><div style="${style(sceneStyle)}">${body}</div></div>`;
}

// One page for WeasyPrint, at 1:1 (htmlToPdf's zoom scales a deck onto its sheet) and with no transform
// above a layer: WeasyPrint lays a page out ignoring transforms and cuts every line whose layout box
// passes the @page height, and clips a translucent layer to the page as its parent's transform maps it.
// So every layer is laid out where it prints (layerPrintCss), straight in the page box.
export function renderPrintPage(page: CanvasPage, resolveMedia?: MediaResolver): string {
    const origin = { x: page.originX, y: page.originY };
    const body = page.layers.map((layer) => renderLayer(layer, layerPrintCss(layer, origin))).join('');
    return `<div class="canvas-page" style="${style(pageStyle(page, 1, resolveMedia))}">${body}</div>`;
}

function pageStyle(page: CanvasPage, scale: number, resolveMedia?: MediaResolver): string[] {
    return [
        'position:relative',
        'overflow:hidden',
        `width:${round(page.width * scale)}px`,
        `height:${round(page.height * scale)}px`,
        ...backgroundCss(page.background, resolveMedia),
    ];
}

// The same page in the fit box every screen consumer scales it in — the HTML export document, the
// lightbox and the drive hero. The box carries the page's composed size as custom properties so one
// rule set (`.page-fit`, the app's, which the export document's own CSS mirrors) fits a slide of either size and a drawing of any ratio the same way.
export function renderFittedPage(page: CanvasPage, scale: number, resolveMedia?: MediaResolver): string {
    const width = round(page.width * scale);
    const height = round(page.height * scale);
    return `<div class="page-fit" style="--page-w:${width}px;--page-ar:${width}/${height}">${renderCanvasPage(page, scale, resolveMedia)}</div>`;
}

function renderLayer(layer: Layer, box: Record<string, string>): string {
    const layerStyle = ['position:absolute', ...Object.entries(box).map(([property, value]) => `${property}:${value}`)];
    // layerInnerHtml is the whole body, the same string the live canvas mounts. It deliberately omits
    // the <p> margin reset a standalone SVG carries: the PDF wrapper's `* { margin: 0 }` and the app's
    // Tailwind preflight each already supply one.
    return `<div style="${style(layerStyle)}">${layerInnerHtml(layer.content)}</div>`;
}

function style(declarations: string[]): string {
    return escapeHtml(declarations.join(';'));
}
