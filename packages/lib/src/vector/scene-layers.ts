// The one function every surface renders through: the live canvas (absolutely positioned divs), the
// thumbnails, present mode and the server compositor. What you see is what prints because there is one
// definition of "the scene as a list of placed boxes".

import { arrowRoute } from './elbow-route';
import { orderByFractionalIndex } from './fractional-index';
import { ELEMENT_KINDS, type RenderOutput } from './kinds';
import type { MediaResolver } from './scene-to-svg';
import type { VectorScene } from './types';

export type Layer = {
    id: string;
    // The element's box in the layer's own coordinate space: scene coordinates on the infinite canvas,
    // frame-relative in frame mode (elements store frame-relative x/y, so no transform is needed).
    box: { x: number; y: number; width: number; height: number; angle: number };
    opacity: number; // 0..100, on the layer rather than baked into the content
    content: RenderOutput;
};

export type SceneLayersOptions = {
    // Render one frame's elements; omit for the whole infinite canvas.
    frameId?: string;
    resolveMedia?: MediaResolver;
};

export function sceneLayers(scene: VectorScene, opts: SceneLayersOptions = {}): Layer[] {
    const { frameId } = opts;
    const visible = frameId === undefined ? scene.elements : scene.elements.filter((el) => el.frameId === frameId);
    // byId spans the whole scene: an elbow arrow inside a frame still routes around its bound shapes.
    const byId = new Map(scene.elements.map((el) => [el.id, el]));
    const layers: Layer[] = [];
    for (const el of orderByFractionalIndex(visible)) {
        // arrowRoute self-guards (not an arrow, or not elbow ⇒ undefined), so no element-type test is needed.
        const content = ELEMENT_KINDS[el.type].render(el, {
            resolveMedia: opts.resolveMedia,
            route: arrowRoute(el, byId),
        });
        // Unresolvable media renders nothing; an empty box is not a layer.
        if ('svg' in content && content.svg === '') continue;
        layers.push({
            id: el.id,
            // An elbow arrow's derived route can spill outside its stored box; the box stays the element's,
            // because the content's coordinates are relative to its origin. Consumers render the fragment in
            // an overflow-visible box.
            box: { x: el.x, y: el.y, width: el.width, height: el.height, angle: el.angle },
            opacity: el.opacity,
            content,
        });
    }
    return layers;
}
