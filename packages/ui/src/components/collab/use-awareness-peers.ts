import { useEffect, useState } from 'react';
import type { WebsocketProvider } from 'y-websocket';

// Subscribes to a Yjs provider's awareness and exposes the remote peers' raw states, keyed by
// clientId with the local client omitted. y-protocols replaces a client's state object only when
// that client changed, so unchanged peers keep object identity across ticks — a memoized per-peer
// view (or a host projection) can skip them. The hook re-renders only when a peer's state reference
// actually changes or a peer joins / leaves: an awareness tick that concerns no peer (e.g. the local
// cursor moving) is a no-op.
//
// `S` documents the awareness state each host publishes; it is a per-app type parameter, never a
// shared union — every host validates its own shape. Hosts project the raw states into whatever they
// render; the hook stays projection-free (no pre-built peers array, no pluggable comparator).
export function useAwarenessPeers<S>(provider: WebsocketProvider | null): Map<number, S> {
    const [peers, setPeers] = useState<Map<number, S>>(() => new Map());

    useEffect(() => {
        if (!provider) {
            setPeers((prev) => (prev.size === 0 ? prev : new Map()));
            return;
        }
        const { awareness } = provider;
        const selfId = awareness.clientID;
        const rebuild = (delta?: { added: number[]; updated: number[]; removed: number[] }) => {
            // Local-only tick (our own throttled cursor / selection publish) changes no peer-visible
            // state — skip the full getStates() rebuild + Map allocation before doing it. This is the
            // hottest path (a ~50ms cursor publish fires 'change' with updated: [selfId]). Genuine
            // peer joins / leaves / updates fall through to the rebuild + identity-compare bail below.
            if (
                delta &&
                delta.added.length === 0 &&
                delta.removed.length === 0 &&
                delta.updated.every((id) => id === selfId)
            ) {
                return;
            }
            setPeers((prev) => {
                const next = new Map<number, S>();
                for (const [clientId, state] of awareness.getStates()) {
                    if (clientId === selfId) continue;
                    next.set(clientId, state as S);
                }
                // No-op bail: same peers with the same state references → keep the previous map so
                // consumers don't re-render for ticks that concern no peer (e.g. our own cursor tick,
                // which fires 'change' with no peer-visible delta).
                if (next.size === prev.size) {
                    let identical = true;
                    for (const [clientId, state] of next) {
                        if (prev.get(clientId) !== state) {
                            identical = false;
                            break;
                        }
                    }
                    if (identical) return prev;
                }
                return next;
            });
        };
        rebuild();
        awareness.on('change', rebuild);
        return () => awareness.off('change', rebuild);
    }, [provider]);

    return peers;
}
