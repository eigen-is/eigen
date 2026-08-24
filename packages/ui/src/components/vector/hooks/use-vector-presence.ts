import type { AuthUser } from '@workspace/lib/auth';
import { userColor } from '@workspace/lib/constants/colors';
import { useCallback, useEffect, useRef } from 'react';
import type { WebsocketProvider } from 'y-websocket';

// A scene point, or null when the pointer leaves the canvas. Published on the awareness `cursor`
// field; the canvas feeds it from pointer moves.
export type PublishCursor = (scene: { x: number; y: number } | null) => void;

const CURSOR_THROTTLE_MS = 50;

// Publishes the local user's presence onto the provider's Yjs awareness: the identity (name + color)
// once, the selection on every change, and a throttled scene cursor. Mirrors sheets' use-presence
// scheme (`userColor(user.id)` + `user.name`), minus the peer→workbook mirroring — the vector
// CursorLayer reads peers straight off awareness keyed by clientId, so sheets' removed-then-rejoin
// re-feed quirk (a departed client sharing a user-identity presence key with a live one) does not
// apply here: each clientId is its own cursor, removed independently.
export function useVectorPresence(
    provider: WebsocketProvider | null,
    user: AuthUser | null,
    selectedIds: string[],
): PublishCursor {
    useEffect(() => {
        if (!provider || !user) return;
        provider.awareness.setLocalStateField('user', {
            name: user.name,
            color: userColor(user.id),
            userId: user.id,
        });
    }, [provider, user]);

    useEffect(() => {
        if (!provider) return;
        provider.awareness.setLocalStateField('selection', selectedIds);
    }, [provider, selectedIds]);

    // Throttled cursor publish (leading + trailing): the trailing timer flushes the pointer's resting
    // position so a peer never sees the cursor freeze one tick short of where it actually stopped.
    const lastSentRef = useRef(0);
    const pendingRef = useRef<{ x: number; y: number } | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        },
        [],
    );

    return useCallback(
        (scene: { x: number; y: number } | null) => {
            const awareness = provider?.awareness;
            if (!awareness) return;
            if (scene === null) {
                if (timerRef.current) {
                    clearTimeout(timerRef.current);
                    timerRef.current = null;
                }
                pendingRef.current = null;
                awareness.setLocalStateField('cursor', null);
                return;
            }
            pendingRef.current = scene;
            const elapsed = Date.now() - lastSentRef.current;
            if (elapsed >= CURSOR_THROTTLE_MS) {
                lastSentRef.current = Date.now();
                awareness.setLocalStateField('cursor', scene);
            } else if (!timerRef.current) {
                timerRef.current = setTimeout(() => {
                    timerRef.current = null;
                    lastSentRef.current = Date.now();
                    if (pendingRef.current) awareness.setLocalStateField('cursor', pendingRef.current);
                }, CURSOR_THROTTLE_MS - elapsed);
            }
        },
        [provider],
    );
}
