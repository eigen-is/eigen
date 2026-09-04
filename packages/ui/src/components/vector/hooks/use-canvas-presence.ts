import type { AuthUser } from '@workspace/lib/auth';
import { useEffect } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import { type CursorPeerState, useAwarenessIdentity, useThrottledAwarenessField } from '../../collab';

// The canvas awareness shape: the shared cursor-layer fields plus the frame the peer is on. Engine-
// private — frameId never enters the shared CursorPeerState.
export type CanvasPeerState = CursorPeerState & { frameId?: string };

// A peer belongs to the frame they are on. A peer that has not published one (an older tab, or one on
// the infinite canvas) reads as '' — the same value the infinite canvas publishes, so it is visible
// there and hidden on any real frame, which is the safe default in both directions.
export function peerOnFrame(state: CanvasPeerState, frameId: string): boolean {
    return (state.frameId ?? '') === frameId;
}

// A scene point, or null when the pointer leaves the canvas. Published on the awareness `cursor`
// field; the canvas feeds it from pointer moves.
export type PublishCursor = (scene: { x: number; y: number } | null) => void;

const CURSOR_THROTTLE_MS = 50;

// Publishes the local user's presence onto the provider's Yjs awareness: the identity (name + color)
// once, the selection on every change, and a throttled scene cursor via the shared
// useThrottledAwarenessField (leading + trailing, null clears immediately). Mirrors sheets'
// use-presence scheme (`userColor(user.id)` + `user.name`), plus the active frame so the shared
// CursorLayer can hide peers on another page (the host-side filter; the layer stays scope-agnostic),
// minus the peer→workbook mirroring — the
// vector CursorLayer reads peers straight off awareness keyed by clientId, so sheets'
// removed-then-rejoin re-feed quirk (a departed client sharing a user-identity presence key with a
// live one) does not apply here: each clientId is its own cursor, removed independently.
export function useCanvasPresence(
    provider: WebsocketProvider | null,
    user: AuthUser | null,
    selectedIds: string[],
    frameId: string,
): PublishCursor {
    useAwarenessIdentity(provider, user);

    useEffect(() => {
        if (!provider) return;
        provider.awareness.setLocalStateField('selection', selectedIds);
    }, [provider, selectedIds]);

    useEffect(() => {
        if (!provider) return;
        provider.awareness.setLocalStateField('frameId', frameId);
    }, [provider, frameId]);

    return useThrottledAwarenessField<{ x: number; y: number }>(provider, 'cursor', CURSOR_THROTTLE_MS);
}
