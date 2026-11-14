// What a canvas tells its peers: the user's identity, selection, frame and cursor, published on the provider's Yjs
// awareness. The canvas editor calls it, and the shared cursor layer uses peerOnFrame to hide peers on another page.

import type { AuthUser } from '@workspace/lib/types/auth';
import { useEffect } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import type { CursorPeerState } from '../../collab';
import { useAwarenessIdentity, useThrottledAwarenessField } from '../../collab';

// The frame a peer is on matters only to the canvas, so it is added here and never enters the shared
// CursorPeerState.
export type CanvasPeerState = CursorPeerState & { frameId?: string };

// A peer belongs to the frame they are on. A peer that has not published one reads as '', the same value
// the infinite canvas publishes, so it is visible there and hidden on any real frame.
export function peerOnFrame(state: CanvasPeerState, frameId: string): boolean {
    return (state.frameId ?? '') === frameId;
}

// A scene point, or null when the pointer leaves the canvas. Published on the awareness `cursor`
// field; the canvas feeds it from pointer moves.
export type PublishCursor = (scene: { x: number; y: number } | null) => void;

const CURSOR_THROTTLE_MS = 50;

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
