// The snap guide lines drawn in the scene group while a move/resize gesture is snapping — one
// full-viewport SVG line per matched edge/centre. Pulled out of canvas-editor.tsx (the canvas only
// dispatches) so this unit can add its own render without the file growing.

import type { SnapLine } from '@workspace/lib/vector';

// Half-length of a guide line in scene units — large enough to span the viewport at any pan/zoom.
const SNAP_LINE_EXTENT = 1_000_000;

export function SnapGuides({ lines }: { lines: SnapLine[] }) {
    return (
        <>
            {lines.map((line, i) => {
                const v = line.orientation === 'vertical';
                return (
                    <line
                        key={i}
                        className="stroke-selection-handle"
                        x1={v ? line.position : -SNAP_LINE_EXTENT}
                        y1={v ? -SNAP_LINE_EXTENT : line.position}
                        x2={v ? line.position : SNAP_LINE_EXTENT}
                        y2={v ? SNAP_LINE_EXTENT : line.position}
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                    />
                );
            })}
        </>
    );
}
