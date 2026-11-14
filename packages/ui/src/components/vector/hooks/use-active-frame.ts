// The deck shell's active frame. Frames come and go under it — a peer deletes one, ⌘Z removes the one
// just added — so the hook derives the live answer from the frame list instead of trusting its own
// state: nearestFrameId keeps the current frame while it exists, and otherwise hands over to its
// neighbor. Every move to another frame, a click, a step or a handover, also trims the selection
// to that frame's elements. `index` and `step` are what the counter and the phone swipe read.

import type { VectorElement, VectorFrame } from '@workspace/lib/vector';
import { nearestFrameId } from '@workspace/lib/vector';
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

export function useActiveFrame(
    frames: VectorFrame[],
    elements: readonly VectorElement[],
    setSelectedIds: Dispatch<SetStateAction<string[]>>,
): {
    frameId: string;
    setFrameId: (id: string) => void;
    index: number;
    step: (delta: number) => void;
} {
    const [requestedId, setRequestedId] = useState('');
    // The position the active frame last held, so a delete can hand over to its neighbor rather than
    // falling back to the first slide. A ref, not state: it must not itself cause a render.
    const lastIndexRef = useRef(0);

    const frameId = nearestFrameId(frames, requestedId, lastIndexRef.current);
    const index = frames.findIndex((frame) => frame.id === frameId);
    // Remember the position for the NEXT resolution in an effect, not during render: a render can be
    // thrown away under concurrent rendering, and a ref written there would keep the discarded value.
    useEffect(() => {
        if (index !== -1) lastIndexRef.current = index;
    }, [index]);

    // Trimmed during render, not in an effect, so the panel never paints the old frame's selection.
    // It trims rather than clears, because a reveal goes to a frame and selects there in one batch.
    const [shownId, setShownId] = useState(frameId);
    if (shownId !== frameId) {
        setShownId(frameId);
        const onFrame = new Set(elements.filter((el) => el.frameId === frameId).map((el) => el.id));
        setSelectedIds((ids) => ids.filter((id) => onFrame.has(id)));
    }

    const step = useCallback(
        (delta: number) => {
            const next = frames[Math.min(Math.max(index + delta, 0), frames.length - 1)];
            if (next) setRequestedId(next.id);
        },
        [frames, index],
    );

    return { frameId, setFrameId: setRequestedId, index: index === -1 ? 0 : index, step };
}
