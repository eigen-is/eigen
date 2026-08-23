import {
    elementToSvg,
    getElementsBounds,
    isTransparent,
    type MediaResolver,
    orderByFractionalIndex,
    type VectorElement,
    type VectorMeta,
} from '@workspace/lib/vector';
import { useMemo } from 'react';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PADDING = 40;

type VectorCanvasProps = {
    elements: VectorElement[];
    meta: VectorMeta;
    // Images resolve to an <image> href; omitted (M1) → images render nothing (elementToSvg null path).
    resolveMedia?: MediaResolver;
};

// The live SVG scene surface. Each element is its own node (keyed + `data-element-id` so M2's
// interaction layer can hit-test back to the model) rendered through the SAME lib render path as
// previews/embeds/export — elementToSvg emits our own escaped `<g>` fragment. M2 replaces the
// interaction internals but this render seam stays.
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
            {/* elementToSvg is our own XML-escaped output — the same fragment previews/export emit. */}
            {ordered.map((el) => (
                <g
                    key={el.id}
                    data-element-id={el.id}
                    dangerouslySetInnerHTML={{ __html: elementToSvg(el, { resolveMedia }) }}
                />
            ))}
        </svg>
    );
}
