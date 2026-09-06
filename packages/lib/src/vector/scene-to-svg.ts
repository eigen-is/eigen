// Pure scene → SVG string. No DOM, no measurement: roughjs's RoughGenerator yields path
// ops as plain data (DOM-free), we serialize them ourselves instead of using RoughSVG,
// and text trusts client-measured width/height so the server never measures. Shared verbatim by the
// clipboard's SVG flavour and the API transform Worker's svg export — the two places a scene leaves
// the app as one standalone file. Every per-kind body lives in the registry (kinds/); this module
// places what a kind draws.

import { escapeXml } from '../core/html';
import { arrowRoute, sceneBounds } from './elbow-route';
import { isTransparentColor } from './fill';
import { orderByFractionalIndex } from './fractional-index';
import { type Box, round } from './geometry';
import { ELEMENT_KINDS } from './kinds';
import { RICH_TEXT_CLASS, SVG_NS } from './scene-layers';
import type { VectorElement, VectorScene } from './types';

// The margin left around a drawing, so a standalone SVG and a compositor page frame it alike.
// sceneBounds is the geometric union of the element boxes and the derived elbow routes; it does not
// inflate for roughjs's overshoot, which is what this padding absorbs.
export const DEFAULT_PADDING = 10;

// A foreignObject clips to its own rect, so text a hair wider than the box the client measured would
// lose its wrapped line; overflow="visible" keeps it drawn. The reset rides INSIDE the wrapper because
// a standalone SVG (download, <img> embed) has none of the app's CSS, where the UA's 1em <p> margins
// would shift the text out of its box — the rest of canvas-text.css is the app's/export document's.
const HTML_WRAPPER_RESET = `<style>.${RICH_TEXT_CLASS} p{margin:0}</style>`;

// Resolve an image element's media reference to an <image> href (data: URI or URL). The
// host (FE/BE) supplies it; unresolvable media renders nothing.
export type MediaResolver = (mediaName: string) => string | null;

type SceneToSvgOptions = {
    resolveMedia?: MediaResolver;
};

export function sceneToSvg(scene: VectorScene, opts: SceneToSvgOptions = {}): string {
    const ordered = orderByFractionalIndex(scene.elements);
    if (ordered.length === 0) {
        return `<svg xmlns="${SVG_NS}" width="0" height="0" viewBox="0 0 0 0"></svg>`;
    }

    // byId feeds the derived elbow route (its bends spill past the stored 2-endpoint box, and depend on the
    // bound shapes) to both bounds and rendering.
    const byId = new Map(scene.elements.map((el) => [el.id, el]));
    const bounds = sceneBounds(ordered, byId);
    const minX = round(bounds.minX - DEFAULT_PADDING);
    const minY = round(bounds.minY - DEFAULT_PADDING);
    const width = round(bounds.maxX - bounds.minX + DEFAULT_PADDING * 2);
    const height = round(bounds.maxY - bounds.minY + DEFAULT_PADDING * 2);

    let body = '';
    if (!isTransparentColor(scene.meta.background)) {
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
        'html' in out
            ? `<foreignObject x="0" y="0" width="${round(el.width)}" height="${round(el.height)}" overflow="visible"><div xmlns="http://www.w3.org/1999/xhtml" class="${RICH_TEXT_CLASS}" style="${escapeXml(out.style)}">${HTML_WRAPPER_RESET}${out.html}</div></foreignObject>`
            : out.svg;
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
