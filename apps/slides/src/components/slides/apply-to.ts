// Which slides a background change lands on. The engine owns the "and following" arithmetic
// (framesFrom); the vocabulary is the deck's, which is why this lives here and not in packages/lib.

import { framesFrom, type VectorFrame } from '@workspace/lib/vector';

export type ApplyTo = 'this' | 'this-and-following' | 'all';

export function targetFrameIds(frames: VectorFrame[], frameId: string, applyTo: ApplyTo): string[] {
    if (applyTo === 'all') return frames.map((frame) => frame.id);
    // A stale id (the slide was deleted under an open panel) applies to nothing — never to the deck.
    if (applyTo === 'this') return frames.some((frame) => frame.id === frameId) ? [frameId] : [];
    return framesFrom(frames, frameId).map((frame) => frame.id);
}
