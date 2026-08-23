import {
    ELEMENT_FIELDS,
    elementToSvg,
    getElementsBounds,
    isTransparent,
    type MediaResolver,
    orderByFractionalIndex,
    type VectorElement,
    type VectorMeta,
} from '@workspace/lib/vector';
import { memo, useMemo } from 'react';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PADDING = 40;

type VectorCanvasProps = {
    elements: VectorElement[];
    meta: VectorMeta;
    // Images resolve to an <image> href; omitted (M1) → images render nothing (elementToSvg null path).
    resolveMedia?: MediaResolver;
};

// readVectorFromDoc materializes fresh element objects on every Yjs tick, so identity-based
// memo never hits; every ELEMENT_FIELDS value is a scalar or string, so a field compare is
// exact. Only changed elements re-run elementToSvg — rough path generation is the expensive part.
function sameElement(a: VectorElement, b: VectorElement): boolean {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    for (const field of ELEMENT_FIELDS) {
        if (ra[field] !== rb[field]) return false;
    }
    return true;
}

const ElementNode = memo(
    // Each element is its own node (keyed + `data-element-id` so M2's interaction layer can
    // hit-test back to the model) rendered through the SAME lib render path as previews/
    // embeds/export — elementToSvg emits our own escaped `<g>` fragment.
    function ElementNode({ el, resolveMedia }: { el: VectorElement; resolveMedia?: MediaResolver }) {
        return <g data-element-id={el.id} dangerouslySetInnerHTML={{ __html: elementToSvg(el, { resolveMedia }) }} />;
    },
    (prev, next) => prev.resolveMedia === next.resolveMedia && sameElement(prev.el, next.el),
);

// The live SVG scene surface. M2 replaces the interaction internals but this render seam stays.
export function VectorCanvas({ elements, meta, resolveMedia }: VectorCanvasProps) {
    const ordered = useMemo(() => orderByFractionalIndex(elements), [elements]);

    // M1 static viewport: fit-to-content viewBox. This is the one place the viewport is derived —
    // M2 replaces it with pan/zoom state.
    const view = useMemo(() => {
        if (ordered.length === 0) return { viewBox: `0 0 100 100`, x: 0, y: 0, width: 100, height: 100 };
        const b = getElementsBounds(ordered);
        const x = b.minX - PADDING;
        const y = b.minY - PADDING;
        const width = b.maxX - b.minX + PADDING * 2;
        const height = b.maxY - b.minY + PADDING * 2;
        return { viewBox: `${x} ${y} ${width} ${height}`, x, y, width, height };
    }, [ordered]);

    return (
        <svg className="h-full w-full" xmlns={SVG_NS} viewBox={view.viewBox} preserveAspectRatio="xMidYMid meet">
            {!isTransparent(meta.background) && (
                <rect x={view.x} y={view.y} width={view.width} height={view.height} fill={meta.background} />
            )}
            {ordered.map((el) => (
                <ElementNode key={el.id} el={el} resolveMedia={resolveMedia} />
            ))}
        </svg>
    );
}
