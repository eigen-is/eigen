// One scene element as its own memoized, absolutely positioned layer on the live canvas. The layer div carries the
// element's box, a transform to its origin and a turn about its center, and holds the kind's body as layerInnerHtml
// writes it. Previews, exports and the print compositor draw through the same lib functions: layerContent decides what
// an element draws, and placeLayer where it goes.

import { sanitizeToLightEditorHtml } from '@workspace/lib/html-dom';
import type { Layer, MediaResolver, RenderOutput, VectorArrowElement, VectorElement } from '@workspace/lib/vector';
import {
    arrowRoute,
    boundShape,
    ELEMENT_FIELDS,
    layerBoxCss,
    layerContent,
    layerInnerHtml,
    PLACEMENT_FIELDS,
    placeLayer,
} from '@workspace/lib/vector';
import { memo, useRef } from 'react';
import type { FitHeight } from './text-fit';
import { useTextBoxAutoFit } from './text-fit';

type ElementLayerProps = {
    el: VectorElement;
    resolveMedia?: MediaResolver;
    // The whole scene map, so an elbow arrow can resolve its bound shapes and derive its route.
    byId?: Map<string, VectorElement>;
    // An in-place editor for this element. While it is present the layer takes pointer events, and the kind's own text
    // body is not drawn, because the user reads the editor instead. The box's paint is still drawn.
    children?: React.ReactNode;
    // A text box's height follows its text: with a writer, the layer measures its own body and fits the box. Every
    // read-only surface omits it, because a thumbnail must not write.
    onFitHeight?: FitHeight;
    // Set by a read-only copy of the canvas, so its defs' ids stay apart from the canvas's (layerContent).
    idScope?: string;
};

// A kind draws in its local frame, so a move, a turn or a fade re-places the body without redrawing it.
const BODY_FIELDS = ELEMENT_FIELDS.filter((field) => !PLACEMENT_FIELDS.includes(field));

// A pan or zoom re-renders without touching the elements, so one identity compare settles it. A drag and a Yjs update
// hand over fresh objects, which need the field compare. Every stored field is a scalar or a string, so it is exact.
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

// A derived elbow arrow is the one layer whose output reads the scene map. It reads only the shapes its two ends are
// bound to, because those are elbowRoute's only obstacles. So the same two shapes mean the same route, and this answers
// that without running A*.
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
    // The same fields and the same scene map give the same output, which is the pan and zoom case. A drag rebuilds the
    // map every frame. Then only a derived elbow arrow with unchanged fields can still need a new route, because one of
    // its bound shapes moved. Comparing the routes themselves would run the router twice per arrow on every frame.
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

// The kind's body, drawn again only when what it reads changed. A move re-renders the layer for its box, and this hands
// back the body it drew before, because rough paths and a whole chart are the expensive part. It writes its cache
// during render, as FrameView's scale does, which is safe because the same inputs always give the same body.
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
    // Stored rich text is mounted here, so it is sanitized here. Its `html` arrives as written by any peer or a forged
    // clipboard record. It is the allowlist the in-place editor runs, so LightEditor markup passes unchanged.
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
    // The layer node, so the text fit can measure the body inside it: its own, or the in-place editor's.
    const hostRef = useRef<HTMLDivElement>(null);
    // A layer that hosts the in-place editor is the box the user types in, so its growth is part of their edit.
    useTextBoxAutoFit(hostRef, el, onFitHeight, !!children);
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
