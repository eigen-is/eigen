import type { AuthUser } from '@workspace/lib/auth';
import {
    type CursorPeerState,
    useAwarenessIdentity,
    useThrottledAwarenessField,
} from '@workspace/ui/components/collab';
import { useEffect } from 'react';
import type { WebsocketProvider } from 'y-websocket';

// The slides awareness shape: the shared cursor-layer fields plus the slides-only slide scope.
// Host-private by design — slideId never enters the shared CursorPeerState (vector-advocate ruling).
export type SlidesPeerState = CursorPeerState & { slideId?: string };

// A slide-unit scene point (0..SLIDE_BASE_WIDTH × 0..SLIDE_BASE_HEIGHT), or null when the pointer
// leaves the canvas. Published on the awareness `cursor` field; the canvas feeds it from pointer moves.
export type PublishCursor = (scene: { x: number; y: number } | null) => void;

const CURSOR_THROTTLE_MS = 50;

// Publishes the local user's presence onto the deck's Yjs awareness: the identity (name + color) once,
// the selected object ids on change, the active slide id on change, and a throttled scene cursor via
// the shared useThrottledAwarenessField (leading + trailing, null clears immediately). Mirrors vector's
// use-canvas-presence (`userColor(user.id)` + `user.name`) with one slides-only field — `slideId` — so
// the shared CursorLayer can hide peers viewing a different slide (the host-side filter; the layer
// itself stays scope-agnostic). Cursor lives in slide-unit space so a peer renders at the right spot on
// any canvas size (the same units boxToStyle maps to percent). Not gated on write access: a read-only
// viewer is a visible peer, exactly as in vector and the docs caret — viewers publish identity + cursor.
export function useSlidesPresence(
    provider: WebsocketProvider | null,
    user: AuthUser | null,
    selectedIds: string[],
    activeSlideId: string | null,
): PublishCursor {
    useAwarenessIdentity(provider, user);

    useEffect(() => {
        if (!provider) return;
        provider.awareness.setLocalStateField('selection', selectedIds);
    }, [provider, selectedIds]);

    useEffect(() => {
        if (!provider) return;
        provider.awareness.setLocalStateField('slideId', activeSlideId);
    }, [provider, activeSlideId]);

    return useThrottledAwarenessField<{ x: number; y: number }>(provider, 'cursor', CURSOR_THROTTLE_MS);
}
