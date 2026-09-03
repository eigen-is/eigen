// One scene element as its own memoized, absolutely positioned layer: a div carrying the element's
// box (a transform to its origin + rotate about the box centre, which is CSS's default
// transform-origin) holding either the kind's unpositioned SVG fragment or its rich-text div. The SAME lib render path
// previews, embeds, export and the print compositor use — elementLayer is the one definition of where
// an element goes and what it draws.

import { sanitizeToLightEditorHtml } from '@workspace/lib/html-dom';
import {
    arrowRoute,
    ELEMENT_FIELDS,
    elementLayer,
    type Layer,
    layerInnerHtml,
    type MediaResolver,
    type Point,
    SVG_NS,
    type VectorElement,
} from '@workspace/lib/vector';
import { memo } from 'react';

type ElementLayerProps = {
    el: VectorElement;
    resolveMedia?: MediaResolver;
    // The whole scene map, so an elbow arrow can resolve its bound shapes and derive its route.
    byId?: Map<string, VectorElement>;
    // An in-place editor for this element. While present the layer takes pointer events and the kind's
    // own body is not drawn — the editor IS what the user sees.
    children?: React.ReactNode;
};

// Pan/zoom and drag re-render without touching elements, so identity settles those in one compare;
// a Yjs tick materializes fresh objects through readVectorFromDoc, so those need the field compare —
// every ELEMENT_FIELDS value is a scalar/string, so it is exact. Only changed elements re-run the
// kind's render — rough path generation is the expensive part.
function sameElement(a: VectorElement, b: VectorElement): boolean {
    if (a === b) return true;
    // Widened, not copied: this runs per element per frame, so a spread here would allocate twice a frame.
    const ra: Record<string, unknown> = a;
    const rb: Record<string, unknown> = b;
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

export function sameLayerProps(prev: ElementLayerProps, next: ElementLayerProps): boolean {
    // A hosted editor is a fresh node every parent render; never memoize it away.
    if (prev.children !== next.children) return false;
    if (prev.resolveMedia !== next.resolveMedia) return false;
    if (!sameElement(prev.el, next.el)) return false;
    // Same element fields AND the same scene map → identical output (the pan/zoom/drag common case).
    // Only when the map changes identity might an elbow arrow need re-routing though its OWN fields
    // are unchanged (a BOUND SHAPE moved) — fall to comparing the derived route so it re-renders then.
    if (prev.byId === next.byId) return true;
    return samePoints(arrowRoute(prev.el, prev.byId), arrowRoute(next.el, next.byId));
}

// The box as CSS. The origin rides in a transform, not in left/top, because the browser pixel-snaps a
// fractional box origin before painting the layer's own <svg> — that put every element up to half a
// pixel off the exact float coordinates the single-<svg> renderer drew at. Transforms are not snapped.
// transform-origin stays the default box centre and translate is origin-independent, so
// `translate(x,y) rotate(a)` is the old renderer's `translate(x y) rotate(a w/2 h/2)` exactly. No
// will-change: promoting 500 layers to their own composited surface costs more memory than it buys.
function layerStyle({ box, opacity }: Pick<Layer, 'box' | 'opacity'>): React.CSSProperties {
    const rotate = box.angle === 0 ? '' : ` rotate(${box.angle}deg)`;
    return {
        left: 0,
        top: 0,
        width: box.width,
        height: box.height,
        transform: `translate(${box.x}px, ${box.y}px)${rotate}`,
        opacity: opacity === 100 ? undefined : opacity / 100,
    };
}

export const ElementLayer = memo(function ElementLayer({ el, resolveMedia, byId, children }: ElementLayerProps) {
    const layer = elementLayer(el, { resolveMedia, route: arrowRoute(el, byId) });
    if (!layer) return null;
    const { content } = layer;
    const style = layerStyle(layer);
    if (children) {
        return (
            <div data-element-id={el.id} className="pointer-events-auto absolute" style={style}>
                {children}
            </div>
        );
    }
    // Rich text IS the layer's own body (one styled div); everything else is an SVG fragment in an
    // overflow-visible viewport, because roughjs overshoots its box and an elbow route spills past it.
    if (!('svg' in content)) {
        // THE mount seam for stored rich text, so this is where it is sanitized: `html` reaches us
        // verbatim from a hostile peer's Y.Doc write or a forged clipboard record. Same allowlist the
        // in-place editor's paste runs, so legitimate LightEditor markup passes through unchanged.
        const html = layerInnerHtml({ ...content, html: sanitizeToLightEditorHtml(content.html) });
        return (
            <div
                data-element-id={el.id}
                className="absolute"
                style={style}
                dangerouslySetInnerHTML={{ __html: html }}
            />
        );
    }
    return (
        <div data-element-id={el.id} className="absolute" style={style}>
            {/* min-*-px: a horizontal arrow's box is 0 high, and a zero-extent SVG viewport disables
                rendering entirely (SVG 2 §8.2). Overflow is visible, so the floor never clips. */}
            <svg
                className="absolute inset-0 h-full min-h-px w-full min-w-px overflow-visible"
                xmlns={SVG_NS}
                dangerouslySetInnerHTML={{ __html: content.svg }}
            />
        </div>
    );
}, sameLayerProps);
