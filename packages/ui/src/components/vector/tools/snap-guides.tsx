// The snap guide lines drawn in the scene group while a move/resize gesture is snapping — one
// full-viewport SVG line per matched edge/centre. Pulled out of vector-canvas.tsx (the canvas only
// dispatches) so this unit can add its own render without the file growing.

import type { SnapLine } from '@workspace/lib/vector';

// Half-length of a guide line in scene units — large enough to span the viewport at any pan/zoom.
const SNAP_LINE_EXTENT = 1_000_000;

export function SnapGuides({ lines }: { lines: SnapLine[] }) {
    return (
        <>
            {lines.map((line, i) =>
                line.orientation === 'vertical' ? (
                    <line
                        key={i}
                        className="stroke-selection-handle"
                        x1={line.position}
                        y1={-SNAP_LINE_EXTENT}
                        x2={line.position}
                        y2={SNAP_LINE_EXTENT}
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                    />
                ) : (
                    <line
                        key={i}
                        className="stroke-selection-handle"
                        x1={-SNAP_LINE_EXTENT}
                        y1={line.position}
                        x2={SNAP_LINE_EXTENT}
                        y2={line.position}
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                    />
                ),
            )}
        </>
    );
}
