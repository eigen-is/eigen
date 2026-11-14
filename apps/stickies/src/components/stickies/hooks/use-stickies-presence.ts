// Who is on which card of a Stickies board, through the board's Yjs awareness. useStickiesPresence publishes the
// user's name, color and the card they work on, such as the one whose dialog is open. useCardPresence turns the
// other peers' states into a map from card to peer, which the board draws as outlines. The board calls both.

import type { AuthUser } from '@workspace/lib/types/auth';
import type { CursorPeerState } from '@workspace/ui/components/collab';
import { useAwarenessIdentity, useAwarenessPeers } from '@workspace/ui/components/collab';
import { useEffect, useMemo, useRef } from 'react';
import type { WebsocketProvider } from 'y-websocket';

// No cursor: each person scrolls the board their own way, so a pointer has no shared place on it.
export type StickiesPeerState = CursorPeerState;

// A remote peer's presence on one card: the identity to tint its outline and label with.
export type CardPeer = { name: string; color: string };

// A read-only viewer publishes too, so others see them, as in Slides and Vector.
export function useStickiesPresence(
    provider: WebsocketProvider | null,
    user: AuthUser | null,
    selectedCardIds: string[],
): void {
    useAwarenessIdentity(provider, user);

    useEffect(() => {
        if (!provider) return;
        provider.awareness.setLocalStateField('selection', selectedCardIds);
    }, [provider, selectedCardIds]);
}

// A peer that didn't change keeps its object, so a card whose peer is the same doesn't re-render.
export function useCardPresence(provider: WebsocketProvider | null): Map<string, CardPeer> {
    const states = useAwarenessPeers<StickiesPeerState>(provider);
    const prevRef = useRef<Map<string, CardPeer>>(new Map());

    return useMemo(() => {
        const next = new Map<string, CardPeer>();
        for (const [, state] of states) {
            if (!state.user) continue;
            const { name, color } = state.user;
            for (const cardId of state.selection ?? []) {
                const prev = prevRef.current.get(cardId);
                next.set(cardId, prev && prev.name === name && prev.color === color ? prev : { name, color });
            }
        }
        prevRef.current = next;
        return next;
    }, [states]);
}
