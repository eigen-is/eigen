// Pure scene → SVG string. No DOM, no measurement: roughjs's RoughGenerator yields path
// ops as plain data (DOM-free), we serialize them ourselves instead of using RoughSVG,
// and text trusts client-measured width/height so the server never measures. Shared verbatim
// by the frontend (previews/embeds/thumbnails/export) and the API transform Worker. Every per-kind
// body lives in the registry (kinds/); this module places what a kind draws.

import { arrowRoute, sceneBounds } from './elbow-route';
import { isTransparentFill } from './fill';
import { orderByFractionalIndex } from './fractional-index';
import type { Box } from './geometry';
import { ELEMENT_KINDS } from './kinds';
import { escapeXml, round } from './kinds/render-utils';
import type { VectorElement, VectorScene } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_PADDING = 10;

// Resolve an image element's media reference to an <image> href (data: URI or URL). The
// host (FE/BE) supplies it; unresolvable media renders nothing.
export type MediaResolver = (mediaName: string) => string | null;

export type SceneToSvgOptions = {
    resolveMedia?: MediaResolver;
    padding?: number;
};

export function sceneToSvg(scene: VectorScene, opts: SceneToSvgOptions = {}): string {
    const ordered = orderByFractionalIndex(scene.elements);
    if (ordered.length === 0) {
        return `<svg xmlns="${SVG_NS}" width="0" height="0" viewBox="0 0 0 0"></svg>`;
    }

    const padding = opts.padding ?? DEFAULT_PADDING;
    // byId feeds the derived elbow route (its bends spill past the stored 2-endpoint box, and depend on the
    // bound shapes) to both bounds and rendering.
    const byId = new Map(scene.elements.map((el) => [el.id, el]));
    const bounds = sceneBounds(ordered, byId);
    const minX = round(bounds.minX - padding);
    const minY = round(bounds.minY - padding);
    const width = round(bounds.maxX - bounds.minX + padding * 2);
    const height = round(bounds.maxY - bounds.minY + padding * 2);

    let body = '';
    if (!isTransparentFill({ type: 'solid', color: scene.meta.background })) {
        body += `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${escapeXml(scene.meta.background)}"/>`;
    }
    for (const el of ordered) {
        body += elementToSvg(el, opts, byId);
    }

    return `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}">${body}</svg>`;
}

// One element → its own SVG fragment (a `<g>`), the exact per-element code path sceneToSvg
// runs. The live canvas (packages/ui) reuses this so its per-element nodes are byte-for-byte
// what previews/embeds/export produce. Every kind renders in its own LOCAL frame; the `<g>` here is
// what places and rotates it.
// `byId` lets an elbow arrow resolve its bound shapes to derive its route; omit it (no scene context)
// and an elbow arrow falls back to its straight stored endpoints.
export function elementToSvg(
    el: VectorElement,
    opts: SceneToSvgOptions = {},
    byId?: Map<string, VectorElement>,
): string {
    // arrowRoute self-guards (not an arrow, or not elbow ⇒ undefined), so no element-type test is needed
    // here — and none survives anywhere outside kinds/.
    const out = ELEMENT_KINDS[el.type].render(el, { resolveMedia: opts.resolveMedia, route: arrowRoute(el, byId) });
    const body =
        'svg' in out
            ? out.svg
            : `<foreignObject x="0" y="0" width="${round(el.width)}" height="${round(el.height)}"><div xmlns="http://www.w3.org/1999/xhtml" style="${escapeXml(out.style)}">${out.html}</div></foreignObject>`;
    if (body === '') return '';
    return `${groupOpen(el)}${body}</g>`;
}

// translate to the element's position, then rotate about its center (angle in degrees —
// SVG rotate() takes degrees directly, no conversion).
function elementTransform(box: Box): string {
    const translate = `translate(${round(box.x)} ${round(box.y)})`;
    if (box.angle === 0) return translate;
    return `${translate} rotate(${round(box.angle)} ${round(box.width / 2)} ${round(box.height / 2)})`;
}

function groupOpen(el: VectorElement): string {
    const opacity = el.opacity !== 100 ? ` opacity="${round(el.opacity / 100)}"` : '';
    return `<g transform="${elementTransform(el)}"${opacity}>`;
}
