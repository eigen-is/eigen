import type { AuthUser } from '@workspace/lib/auth';
import { userColor } from '@workspace/lib/constants/colors';
import { type CursorPeerState, useAwarenessPeers } from '@workspace/ui/components/collab';
import { useEffect, useMemo, useRef } from 'react';
import type { WebsocketProvider } from 'y-websocket';

// The stickies awareness shape: the shared identity + selection fields, no cursor — the board scrolls
// per-user (each column vertically, the board horizontally) so there is no shared pixel space to
// anchor a pointer to. Stickies publishes a subset of the documented CursorPeerState convention
// (`user` + `selection`), so the shared type covers it without a redundant per-app alias.
export type StickiesPeerState = CursorPeerState;

// A remote peer's presence on one card: the identity to tint its outline and label with.
export type CardPeer = { name: string; color: string };

// Publishes the local user's presence onto the board's Yjs awareness: identity (name + color) once,
// and the card the user is "working on" on change. "Working on" = the card whose edit dialog is open,
// else the card actively being dragged (the host computes it and hands over 0-or-1 ids). Mirrors
// use-slides-presence (`userColor(user.id)` + `user.name`) minus the cursor field. Awareness is
// ephemeral — this never touches the columns/tasks/columnOrder Yjs roots, so stickies stays BC-frozen.
// Not gated on write access: a read-only viewer is a visible peer, exactly as in slides and vector.
export function useStickiesPresence(
    provider: WebsocketProvider | null,
    user: AuthUser | null,
    selectedCardIds: string[],
): void {
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
        provider.awareness.setLocalStateField('selection', selectedCardIds);
    }, [provider, selectedCardIds]);
}

// Projects the board's remote awareness into a card-id → peer map for the outline + name chip. Built
// on the shared useAwarenessPeers (never a hand-rolled awareness subscription), memoized and
// identity-preserving: an unchanged peer keeps its CardPeer object across ticks, so a card whose peer
// didn't change never re-renders. Last-writer-wins if two peers claim the same card (a rare presence
// collision — one outline can only carry one color).
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
