// One scene element as its own memoized, absolutely positioned layer: a div carrying the element's
// box (a transform to its origin + rotate about the box center, which is CSS's default
// transform-origin) holding the kind's body as layerInnerHtml writes it. The SAME lib render path
// previews, embeds, export and the print compositor use — elementLayer's two halves, layerContent and
// placeLayer, are the one definition of what an element draws and where it goes.

import { sanitizeToLightEditorHtml } from '@workspace/lib/html-dom';
import {
    arrowRoute,
    boundShape,
    ELEMENT_FIELDS,
    type Layer,
    layerBoxCss,
    layerContent,
    layerInnerHtml,
    type MediaResolver,
    PLACEMENT_FIELDS,
    placeLayer,
    type RenderOutput,
    type VectorArrowElement,
    type VectorElement,
} from '@workspace/lib/vector';
import { memo, useRef } from 'react';
import { type FitHeight, useRichTextAutoFit } from './text-fit';

type ElementLayerProps = {
    el: VectorElement;
    resolveMedia?: MediaResolver;
    // The whole scene map, so an elbow arrow can resolve its bound shapes and derive its route.
    byId?: Map<string, VectorElement>;
    // An in-place editor for this element. While present the layer takes pointer events and the kind's
    // own text body is not drawn — the editor IS what the user reads — but its box paint still is.
    children?: React.ReactNode;
    // Rich text's height follows its text: pass a writer and the layer measures its own body and fits
    // the box (text-fit.ts). Omitted by every read-only surface — a thumbnail must not write.
    onFitHeight?: FitHeight;
    // Set by a read-only copy of the canvas, so its defs' ids stay apart from the canvas's (layerContent).
    idScope?: string;
};

// A kind draws in its local frame, so a move, a turn or a fade re-places the body without redrawing it.
const BODY_FIELDS = ELEMENT_FIELDS.filter((field) => !PLACEMENT_FIELDS.includes(field));

// Pan/zoom re-renders without touching elements, so identity settles those in one compare; a drag and
// a Yjs tick hand over fresh objects, so those need the field compare — every ELEMENT_FIELDS value is a
// scalar/string, so it is exact.
function sameFields(a: VectorElement, b: VectorElement, fields: readonly string[]): boolean {
    if (a === b) return true;
    // Widened, not copied: this runs per element per frame, so a spread here would allocate twice a frame.
    const ra: Record<string, unknown> = a;
    const rb: Record<string, unknown> = b;
    for (const field of fields) {
        if (ra[field] !== rb[field]) return false;
    }
    return true;
}

// A derived elbow route is routed in scene space around its bound shapes and then made local to the
// arrow's origin, so it is the one body that moves with the element's own x and y.
function derivesRoute(el: VectorElement): el is VectorArrowElement {
    return el.type === 'arrow' && el.elbow && el.fixedSegments === '';
}

// A derived elbow arrow is the one layer whose output reads the scene map, and it reads it ONLY for the
// shapes its two ends are bound to (elbowRoute's obstacles are the bound shapes, nothing else). So the
// same two shapes mean the same route — answered without running A* to find out.
function sameRouteContext(
    el: VectorElement,
    prev?: Map<string, VectorElement>,
    next?: Map<string, VectorElement>,
): boolean {
    if (!derivesRoute(el)) return true;
    // Without a map an elbow arrow draws its stored endpoints instead, which is a different polyline.
    if (!prev || !next) return false;
    for (const binding of [el.startBinding, el.endBinding]) {
        const a = boundShape(binding, prev);
        const b = boundShape(binding, next);
        if (a === b) continue;
        if (!a || !b || !sameFields(a, b, ELEMENT_FIELDS)) return false;
    }
    return true;
}

export function sameLayerProps(prev: ElementLayerProps, next: ElementLayerProps): boolean {
    // A hosted editor is a fresh node every parent render; never memoize it away.
    if (prev.children !== next.children) return false;
    // The canvas swaps this to undefined for the length of a gesture, which is how a live resize keeps
    // the auto-fit off the box it is dragging.
    if (prev.onFitHeight !== next.onFitHeight) return false;
    if (prev.resolveMedia !== next.resolveMedia || prev.idScope !== next.idScope) return false;
    if (!sameFields(prev.el, next.el, ELEMENT_FIELDS)) return false;
    // Same element fields AND the same scene map → identical output (the pan/zoom common case). A drag
    // rebuilds the map every frame, so identity alone cannot settle those: only an elbow arrow whose
    // OWN fields are unchanged might still need re-routing (a BOUND SHAPE moved), and that is the one
    // thing worth asking about — comparing derived routes here would re-run the router on every arrow,
    // twice, per frame of the drag.
    if (prev.byId === next.byId) return true;
    return sameRouteContext(next.el, prev.byId, next.byId);
}

type BodyCache = {
    el: VectorElement;
    resolveMedia?: MediaResolver;
    byId?: Map<string, VectorElement>;
    idScope?: string;
    content: RenderOutput | null;
};

// The kind's body, redrawn only when what it reads changed: a move re-renders the layer for its box, and
// this hands back the body it drew before — rough path generation, and a whole chart, are the expensive
// part. Written during render like FrameView's scale: the same inputs always give the same body.
function useLayerBody(
    el: VectorElement,
    resolveMedia?: MediaResolver,
    byId?: Map<string, VectorElement>,
    idScope?: string,
): RenderOutput | null {
    const cache = useRef<BodyCache | null>(null);
    const prev = cache.current;
    if (
        prev &&
        prev.resolveMedia === resolveMedia &&
        prev.idScope === idScope &&
        sameFields(prev.el, el, derivesRoute(el) ? ELEMENT_FIELDS : BODY_FIELDS) &&
        (prev.byId === byId || sameRouteContext(el, prev.byId, byId))
    ) {
        return prev.content;
    }
    const content = layerContent(el, { resolveMedia, route: arrowRoute(el, byId), idScope });
    // THE mount seam for stored rich text, so this is where it is sanitized: `html` reaches us
    // verbatim from a hostile peer's Y.Doc write or a forged clipboard record. Same allowlist the
    // in-place editor's paste runs, so legitimate LightEditor markup passes through unchanged.
    const safe = content && 'html' in content ? { ...content, html: sanitizeToLightEditorHtml(content.html) } : content;
    cache.current = { el, resolveMedia, byId, idScope, content: safe };
    return safe;
}

// The box as CSS: lib's layerBoxCss with left/top pinned at zero, because the origin rides in the
// transform (see layerBoxCss for why). No will-change: promoting 500 layers to their own composited
// surface costs more memory than it buys.
function layerStyle(layer: Pick<Layer, 'box' | 'opacity'>): React.CSSProperties {
    return { left: 0, top: 0, ...layerBoxCss(layer) };
}

export const ElementLayer = memo(function ElementLayer({
    el,
    resolveMedia,
    byId,
    children,
    onFitHeight,
    idScope,
}: ElementLayerProps) {
    // The layer node, so rich text can measure the body inside it — its own, or the in-place editor's.
    const hostRef = useRef<HTMLDivElement>(null);
    // Hosting the in-place editor IS the user typing in this box, which is what makes its growth
    // part of their edit rather than bookkeeping.
    useRichTextAutoFit(hostRef, el, onFitHeight, !!children);
    const content = useLayerBody(el, resolveMedia, byId, idScope);
    if (!content) return null;
    const style = layerStyle(placeLayer(el, content));
    if (children) {
        // display:contents, so the backdrop's absolute viewport resolves against the layer box and the
        // editor stays the layer's last element child, which is the node the auto-fit measures.
        return (
            <div ref={hostRef} data-element-id={el.id} className="pointer-events-auto absolute" style={style}>
                {content.svg === '' ? null : (
                    <span
                        className="contents pointer-events-none"
                        dangerouslySetInnerHTML={{ __html: layerInnerHtml({ svg: content.svg }) }}
                    />
                )}
                {children}
            </div>
        );
    }
    return (
        <div
            ref={hostRef}
            data-element-id={el.id}
            className="absolute"
            style={style}
            dangerouslySetInnerHTML={{ __html: layerInnerHtml(content) }}
        />
    );
}, sameLayerProps);
