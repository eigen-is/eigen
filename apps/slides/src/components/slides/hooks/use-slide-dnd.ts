// Slide reorder: dnd-kit gives us "the dragged slide landed where this one is", and the frame writer
// takes "put it after that one" — so the hook resolves the destination against the deck WITHOUT the
// dragged slide, which is the same order the fractional-index writer computes against. One key is
// written, so a peer's concurrent rename of either slide survives the move.

import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import type { VectorFrame } from '@workspace/lib/vector';
import { useState } from 'react';

type UseSlideDndProps = {
    frames: VectorFrame[];
    // null lands the slide at the FRONT of the deck.
    moveFrame: (id: string, afterId: string | null) => void;
};

export const useSlideDnd = ({ frames, moveFrame }: UseSlideDndProps) => {
    const [dragActiveId, setDragActiveId] = useState<string | null>(null);

    // dnd-kit ids are string | number; ours are always the frame ids we handed it.
    const handleDragStart = (event: DragStartEvent) => setDragActiveId(String(event.active.id));

    const handleDragEnd = (event: DragEndEvent) => {
        setDragActiveId(null);
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const ids = frames.map((frame) => frame.id);
        const from = ids.indexOf(String(active.id));
        const to = ids.indexOf(String(over.id));
        if (from === -1 || to === -1) return;
        const next = [...ids];
        next.splice(from, 1);
        next.splice(to, 0, String(active.id));
        moveFrame(String(active.id), next[to - 1] ?? null);
    };

    return { dragActiveId, handleDragStart, handleDragEnd };
};
