// The scene as an ordered list of placed boxes: one definition of "where does this element go and what
// does it draw", so the live canvas (one absolutely positioned div per element), the server compositor
// (the same boxes as HTML) and the standalone SVG serializer agree by construction. The canvas draws one
// elementLayer per element (ElementLayer); sceneLayers is the same pass over a whole scene, for a host
// that lays a whole page out at once.

import { escapeXml } from '../core/html';
import { arrowRoute } from './elbow-route';
import { orderByFractionalIndex } from './fractional-index';
import { elementsInFrame } from './frames';
import { type Point, round } from './geometry';
import { ELEMENT_KINDS, type RenderOutput } from './kinds';
import type { MediaResolver } from './scene-to-svg';
import type { VectorElement, VectorScene } from './types';

// The SVG namespace, one spelling for every surface that writes it: the viewports this module emits,
// the documents scene-to-svg serializes and the live <svg> nodes the canvas mounts.
export const SVG_NS = 'http://www.w3.org/2000/svg';

export type Layer = {
    id: string;
    // The element's box in the layer's own coordinate space: scene coordinates on the infinite canvas,
    // frame-relative in frame mode (elements store frame-relative x/y, so no transform is needed).
    box: { x: number; y: number; width: number; height: number; angle: number };
    opacity: number; // 0..100, on the layer rather than baked into the content
    content: RenderOutput;
};

type SceneLayersOptions = {
    // Render one frame's elements; omit for the whole infinite canvas.
    frameId?: string;
    resolveMedia?: MediaResolver;
    // The whole scene by id, for a caller that already holds one — a deck composes page after page off
    // the same elements, and rebuilding the map per frame is the deck's element count squared.
    byId?: Map<string, VectorElement>;
};

type ElementLayerOptions = {
    resolveMedia?: MediaResolver;
    // An elbow arrow's derived route; without it the arrow falls back to its stored endpoints.
    route?: Point[];
};

// One element as a placed layer, or null when the kind draws nothing at all (an image with no media
// name and no border is the only such element today). The live canvas
// renders per element with local preview overrides, so it calls this directly; sceneLayers is the same
// function over a whole scene.
export function elementLayer(el: VectorElement, opts: ElementLayerOptions = {}): Layer | null {
    const content = ELEMENT_KINDS[el.type].render(el, { resolveMedia: opts.resolveMedia, route: opts.route });
    if (!('html' in content) && content.svg === '') return null;
    return {
        id: el.id,
        // An elbow arrow's derived route can spill outside its stored box; the box stays the element's,
        // because the content's coordinates are relative to its origin. Consumers render the fragment in
        // an overflow-visible box.
        box: { x: el.x, y: el.y, width: el.width, height: el.height, angle: el.angle },
        opacity: el.opacity,
        content,
    };
}

type LayerBoxCss = { width: string; height: string; transform: string; opacity?: string };

// The layer's box as CSS: one derivation, set as React style props by the live canvas and serialized
// into a style attribute by the compositor, so what a user sees is what prints. The origin rides in a
// transform rather than in left/top because a browser pixel-snaps a fractional box origin before
// painting the layer's own <svg>; transforms are not snapped. transform-origin stays the default box
// centre and translate is origin-independent, so `translate(x,y) rotate(a)` is the single-<svg>
// renderer's `translate(x y) rotate(a w/2 h/2)` exactly.
export function layerBoxCss({ box, opacity }: Pick<Layer, 'box' | 'opacity'>): LayerBoxCss {
    const rotate = box.angle === 0 ? '' : ` rotate(${round(box.angle)}deg)`;
    return {
        width: `${round(box.width)}px`,
        height: `${round(box.height)}px`,
        transform: `translate(${round(box.x)}px,${round(box.y)}px)${rotate}`,
        ...(opacity === 100 ? null : { opacity: `${round(opacity / 100)}` }),
    };
}

// The class every rich-text body wraps in. It carries the descendant rules an inline style cannot
// reach — list markers, blockquote rule, link underline (packages/ui/src/styles/canvas-text.css,
// which the app imports and the standalone export document embeds).
export const RICH_TEXT_CLASS = 'eigen-canvas-text';

// The layer's body as one HTML string — everything a DOM host mounts inside the layer box, so the live
// canvas and the compositor cannot drift: an svg fragment in its own viewport, rich text in the styled
// wrapper div over its own backdrop viewport. No <p> reset here — a live layer sits in the app, whose CSS
// already resets block margins; a standalone SVG carries its own (scene-to-svg.ts).
export function layerInnerHtml(content: RenderOutput): string {
    if (!('html' in content)) return svgViewport(content.svg);
    // The backdrop viewport is absolute, so the text div takes a position of its own to stack over it.
    const backdrop = content.svg === '' ? '' : svgViewport(content.svg);
    const style = backdrop === '' ? content.style : `${content.style};position:relative`;
    return `${backdrop}<div class="${RICH_TEXT_CLASS}" style="${escapeXml(style)}">${content.html}</div>`;
}

// min-*-px: a horizontal arrow's box is 0 high, and a zero-extent viewport disables rendering entirely
// (SVG 2 §8.2); overflow is visible, so the floor never clips and roughjs's overshoot stays drawn.
function svgViewport(fragment: string): string {
    const style = 'position:absolute;top:0;left:0;width:100%;height:100%;min-width:1px;min-height:1px;overflow:visible';
    return `<svg xmlns="${SVG_NS}" overflow="visible" style="${style}">${fragment}</svg>`;
}

export function sceneLayers(scene: VectorScene, opts: SceneLayersOptions = {}): Layer[] {
    const { frameId } = opts;
    const visible = frameId === undefined ? scene.elements : elementsInFrame(scene.elements, frameId);
    // byId spans the whole scene: an elbow arrow inside a frame still routes around its bound shapes.
    const byId = opts.byId ?? new Map(scene.elements.map((el) => [el.id, el]));
    const layers: Layer[] = [];
    for (const el of orderByFractionalIndex(visible)) {
        // arrowRoute self-guards (not an arrow, or not elbow => undefined), so no element-type test is needed.
        const layer = elementLayer(el, { resolveMedia: opts.resolveMedia, route: arrowRoute(el, byId) });
        if (layer) layers.push(layer);
    }
    return layers;
}
