import type { AuthUser } from '@workspace/lib/auth';
import { userColor } from '@workspace/lib/constants/colors';
import type { PeerPresence, WorkbookInstance } from '@workspace/sheet';
import { presencesFromPeers } from '@workspace/sheet';
import { useAwarenessPeers } from '@workspace/ui/components/collab';
import { useCallback, useEffect, useRef } from 'react';
import type { WebsocketProvider } from 'y-websocket';

export type PublishSelection = (sheetId: string, r: number, c: number) => void;

type Identity = { username: string; userId?: string };

const identityOf = (peer: PeerPresence): Identity | null =>
    peer.user ? { username: peer.user.name, userId: peer.user.userId } : null;

// Publishes the local identity and cursor over Yjs awareness, and mirrors every peer's cursor into the workbook.
// Returns the callback the editor calls when the selection changes.
export function usePresence(
    provider: WebsocketProvider | null,
    workbookRef: React.RefObject<WorkbookInstance | null>,
    user: AuthUser | null,
    synced: boolean,
    snapshotVersion: number,
): PublishSelection {
    const lastSelectionRef = useRef<string>('');
    // A departed client's awareness state is already gone, so its identity comes from this previous map.
    const prevPeersRef = useRef<Map<number, PeerPresence>>(new Map());

    // The hook omits this client, so a same-user entry is the user's other window and shows like any peer.
    const peers = useAwarenessPeers<PeerPresence>(provider);

    // A new snapshot remounts the Workbook and wipes its presences, so the identity is published again.
    useEffect(() => {
        if (!provider || !user || !synced) return;
        provider.awareness.setLocalStateField('user', {
            name: user.name,
            color: userColor(user.id),
            userId: user.id,
        });
        lastSelectionRef.current = '';
    }, [provider, user, synced, snapshotVersion]);

    // A remount wipes the workbook's presences, so the whole live set is added again on snapshotVersion.
    useEffect(() => {
        if (!provider || !user || !synced) return;
        const workbook = workbookRef.current;
        if (!workbook) return;

        // Departed = present in the previous map, gone from the current one.
        const removed: Identity[] = [];
        for (const [clientId, prevPeer] of prevPeersRef.current) {
            if (peers.has(clientId)) continue;
            const identity = identityOf(prevPeer);
            if (identity) removed.push(identity);
        }
        // Remove first, then add the live set: a departed client can share its key with a live one (same user).
        if (removed.length > 0) workbook.removePresences(removed);
        const toAdd = presencesFromPeers(peers);
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
