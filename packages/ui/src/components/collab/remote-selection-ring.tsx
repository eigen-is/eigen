import type { Box } from '@workspace/lib/vector';
import type { CSSProperties } from 'react';

// A remote collaborator's "I'm working here" outline around one object. Same geometry as the local
// selection chrome — `.eigen-selection-ring` (1px, outline-offset 4px), rotation-aware — tinted to
// the peer's color via the `--peer-color` custom property. One CSS source for local and remote
// rings, so a peer's outline reads exactly like your own, just colored. The host supplies the
// scene-box → container-px mapping (`boxToStyle`, the same seam ObjectTransform draws on); the ring
// reads rotation off `box.angle` (no separate angle prop).
export function RemoteSelectionRing({
    box,
    boxToStyle,
    color,
}: {
    box: Box;
    boxToStyle: (box: Box) => CSSProperties;
    color: string;
}) {
    return (
        <div
            className="eigen-selection-ring eigen-selection-ring-peer pointer-events-none absolute"
            style={
                {
                    ...boxToStyle(box),
                    transform: box.angle ? `rotate(${box.angle}deg)` : undefined,
                    transformOrigin: 'center center',
                    '--peer-color': color,
                } as CSSProperties
            }
        />
    );
}
