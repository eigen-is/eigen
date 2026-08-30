// One scene element as its own memoized SVG node, rendered through the SAME lib render path as
// previews, embeds and export — elementToSvg emits our own escaped `<g>` fragment. Split out of
// vector-canvas.tsx (the canvas only dispatches; per-node rendering lives here).

import { ELEMENT_FIELDS, elementToSvg, type MediaResolver, type VectorElement } from '@workspace/lib/vector';
import { memo } from 'react';

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

export const ElementNode = memo(
    function ElementNode({ el, resolveMedia }: { el: VectorElement; resolveMedia?: MediaResolver }) {
        return <g data-element-id={el.id} dangerouslySetInnerHTML={{ __html: elementToSvg(el, { resolveMedia }) }} />;
    },
    (prev, next) => prev.resolveMedia === next.resolveMedia && sameElement(prev.el, next.el),
);
