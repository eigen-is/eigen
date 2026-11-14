// Publishes the signed-in user's name, color and id on a collab document's Yjs awareness, in the `user` field every
// presence host reads a peer from. An editor's presence hook, such as the canvas's or the stickies board's, calls it
// once per provider. Sheets publishes its own, because it waits for the first sync.

import { userColor } from '@workspace/lib/constants/colors';
import type { AuthUser } from '@workspace/lib/types/auth';
import { useEffect } from 'react';
import type { WebsocketProvider } from 'y-websocket';

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
