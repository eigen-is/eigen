// A remote collaborator's "I'm working here" outline around one object. It draws with the same
// `.eigen-selection-ring` class as your own selection, tinted through `--peer-color`, so a peer's
// outline reads like yours, just colored, and turns with the object's angle. The host, such as a
// slide or drawing canvas, maps the object's box to container pixels through `boxToStyle`.

import type { Box } from '@workspace/lib/vector';
import type { CSSProperties } from 'react';

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
            style={{
                ...boxToStyle(box),
                transform: box.angle ? `rotate(${box.angle}deg)` : undefined,
                transformOrigin: 'center center',
                '--peer-color': color,
            }}
        />
    );
}
