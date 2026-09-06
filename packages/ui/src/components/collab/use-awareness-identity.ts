import type { AuthUser } from '@workspace/lib/auth';
import { userColor } from '@workspace/lib/constants/colors';
import { useEffect } from 'react';
import type { WebsocketProvider } from 'y-websocket';

// Publishes the local user's identity onto the provider's Yjs awareness in the shared CursorPeerState
// `user` shape (name + deterministic `userColor(user.id)` + userId) — the one field every presence
// host writes the same way. Extracted from the byte-identical effect in use-canvas-presence /
// use-stickies-presence. Sheets keeps its own copy: it is synced-gated and
// re-published on snapshotVersion (remount survival), so it doesn't fit this plain [provider, user] form.
export function useAwarenessIdentity(provider: WebsocketProvider | null, user: AuthUser | null): void {
    useEffect(() => {
        if (!provider || !user) return;
        provider.awareness.setLocalStateField('user', {
            name: user.name,
            color: userColor(user.id),
            userId: user.id,
        });
    }, [provider, user]);
}
