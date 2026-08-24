import type { AuthUser } from '@workspace/lib/auth';
import { userColor } from '@workspace/lib/constants/colors';
import { type PeerPresence, presencesFromPeers, type WorkbookInstance } from '@workspace/sheet';
import { useAwarenessPeers } from '@workspace/ui/components/collab';
import { useCallback, useEffect, useRef } from 'react';
import type { WebsocketProvider } from 'y-websocket';

export type PublishSelection = (sheetId: string, r: number, c: number) => void;

type Identity = { username: string; userId?: string };

const identityOf = (peer: PeerPresence): Identity | null =>
    peer.user ? { username: peer.user.name, userId: peer.user.userId } : null;

// Wires Yjs awareness into the workbook's presence API: publishes the local user identity + cursor,
// and mirrors every peer's cursor into addPresences/removePresences. Sits on the shared
// `useAwarenessPeers` hook for the subscription + clientId-keyed diff bookkeeping; the sheets-specific
// invariants (identity-keyed multi-tab dedupe, removed-client re-feed, snapshotVersion remount
// survival, self-skip by userId) live in the reconcile pass and `presencesFromPeers` below.
// Returns a publishSelection callback the editor calls from the Workbook's afterSelectionChange hook.
export function usePresence(
    provider: WebsocketProvider | null,
    workbookRef: React.RefObject<WorkbookInstance | null>,
    user: AuthUser | null,
    synced: boolean,
    snapshotVersion: number,
): PublishSelection {
    const lastSelectionRef = useRef<string>('');
    // The peer map from the previous reconcile pass. A client present here but gone from the current
    // map has departed; its remembered identity translates back into a removePresences() key even
    // though its awareness state is already gone from getStates() — the job the old hand-rolled
    // `identities` map did, now derived from the previous-map diff.
    const prevPeersRef = useRef<Map<number, PeerPresence>>(new Map());

    // clientId-keyed remote awareness states; the local client (by clientId) is already omitted by
    // the hook. Multi-tab self-skip (same userId, different clientId) still happens in
    // presencesFromPeers, so a user never sees their own cursor from another tab.
    const peers = useAwarenessPeers<PeerPresence>(provider);

    // Publish the local identity. snapshotVersion is a dep because a peer snapshot flush remounts the
    // Workbook (the editor keys it by snapshotVersion), wiping context.presences — re-publishing the
    // local user field keeps this client visible to peers after the fresh mount.
    useEffect(() => {
        if (!provider || !user || !synced) return;
        provider.awareness.setLocalStateField('user', {
            name: user.name,
            color: userColor(user.id),
            userId: user.id,
        });
        lastSelectionRef.current = '';
    }, [provider, user, synced, snapshotVersion]);

    // Mirror the peer map into the workbook's imperative presence API. Re-runs whenever the peer map
    // changes (join / leave / cursor move) and on snapshotVersion — a remount wipes context.presences,
    // so the full live set is re-added into the fresh workbook instance.
    useEffect(() => {
        if (!provider || !user || !synced) return;
        const workbook = workbookRef.current;
        if (!workbook) return;
        const selfUserId = user.id;

        // Departed = present in the previous map, gone from the current one.
        const removed: Identity[] = [];
        for (const [clientId, prevPeer] of prevPeersRef.current) {
            if (peers.has(clientId)) continue;
            const identity = identityOf(prevPeer);
            if (identity) removed.push(identity);
        }
        // Remove first, THEN re-add the whole live set: a departed clientId can share a Presence key
        // (userId ?? username) with a still-live client — the same user's other tab, or a crash/rejoin
        // under a new clientId. removePresences() just deleted that shared row, so adding the live set
        // back restores it. addPresences overwrites by key, so a peer's moved cursor updates in place.
        if (removed.length > 0) workbook.removePresences(removed);
        const toAdd = presencesFromPeers([...peers.values()], selfUserId);
        if (toAdd.length > 0) workbook.addPresences(toAdd);

        prevPeersRef.current = peers;
    }, [provider, user, synced, snapshotVersion, workbookRef, peers]);

    return useCallback(
        (sheetId: string, r: number, c: number) => {
            if (!provider) return;
            const key = `${sheetId}:${r}:${c}`;
            if (key === lastSelectionRef.current) return;
            lastSelectionRef.current = key;
            provider.awareness.setLocalStateField('selection', { sheetId, r, c });
        },
        [provider],
    );
}
