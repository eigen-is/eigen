// One scene element as its own memoized SVG node, rendered through the SAME lib render path as
// previews, embeds and export — elementToSvg emits our own escaped `<g>` fragment. Split out of
// vector-canvas.tsx (the canvas only dispatches; per-node rendering lives here).

import {
    ELEMENT_FIELDS,
    elementToSvg,
    type MediaResolver,
    type Point,
    type VectorElement,
} from '@workspace/lib/vector';
import { memo } from 'react';
import { arrowRouteOf } from './arrow-route';

// Pan/zoom and drag re-render without touching elements, so identity settles those in one compare;
// a Yjs tick materializes fresh objects through readVectorFromDoc, so those need the field compare —
// every ELEMENT_FIELDS value is a scalar/string, so it is exact. Only changed elements re-run
// elementToSvg — rough path generation is the expensive part.
function sameElement(a: VectorElement, b: VectorElement): boolean {
    if (a === b) return true;
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    for (const field of ELEMENT_FIELDS) {
        if (ra[field] !== rb[field]) return false;
    }
    return true;
}

function samePoints(a: Point[] | undefined, b: Point[] | undefined): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].x !== b[i].x || a[i].y !== b[i].y) return false;
    }
    return true;
}

// `byId` lets an elbow arrow resolve its bound shapes and derive its route (elementToSvg does the same
// for previews/export). It is the whole scene map, so a NON-elbow node never reads it.
export const ElementNode = memo(
    function ElementNode({
        el,
        resolveMedia,
        byId,
    }: {
        el: VectorElement;
        resolveMedia?: MediaResolver;
        byId?: Map<string, VectorElement>;
    }) {
        return (
            <g data-element-id={el.id} dangerouslySetInnerHTML={{ __html: elementToSvg(el, { resolveMedia }, byId) }} />
        );
    },
    (prev, next) => {
        if (prev.resolveMedia !== next.resolveMedia) return false;
        if (!sameElement(prev.el, next.el)) return false;
        // Same element fields AND the same scene map → identical output (the pan/zoom/drag common case).
        // Only when the map changes identity might an elbow arrow need re-routing though its OWN fields
        // are unchanged (a BOUND SHAPE moved) — fall to comparing the derived route so it re-renders then.
        if (prev.byId === next.byId) return true;
        return samePoints(arrowRouteOf(prev.el, prev.byId), arrowRouteOf(next.el, next.byId));
    },
);
