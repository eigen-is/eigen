// The deck shell's active frame. Frames come and go under it — a peer deletes one, ⌘Z removes the one
// just added — so the hook derives the live answer from the frame list instead of trusting its own
// state: nearestFrameId keeps the current frame while it exists, and otherwise hands over to whatever
// now occupies its position (packages/lib/src/vector/frames.ts owns that decision, so it is testable
// without a DOM). `index` and `step` are what the counter and the phone swipe read.

import { nearestFrameId, type VectorFrame } from '@workspace/lib/vector';
import { useCallback, useEffect, useRef, useState } from 'react';

export function useActiveFrame(frames: VectorFrame[]): {
    frameId: string;
    setFrameId: (id: string) => void;
    index: number;
    step: (delta: number) => void;
} {
    const [requestedId, setRequestedId] = useState('');
    // The position the active frame last held, so a delete can hand over to its neighbour rather than
    // falling back to the first slide. A ref, not state: it must not itself cause a render.
    const lastIndexRef = useRef(0);

    const frameId = nearestFrameId(frames, requestedId, lastIndexRef.current);
    const index = frames.findIndex((frame) => frame.id === frameId);
    // Remember the position for the NEXT resolution in an effect, not during render: a render can be
    // thrown away under concurrent rendering, and a ref written there would keep the discarded value.
    useEffect(() => {
        if (index !== -1) lastIndexRef.current = index;
    }, [index]);

    const step = useCallback(
        (delta: number) => {
            const at = frames.findIndex((frame) => frame.id === frameId);
            const next = frames[Math.min(Math.max(at + delta, 0), frames.length - 1)];
            if (next) setRequestedId(next.id);
        },
        [frames, frameId],
    );

    return { frameId, setFrameId: setRequestedId, index: index === -1 ? 0 : index, step };
}
