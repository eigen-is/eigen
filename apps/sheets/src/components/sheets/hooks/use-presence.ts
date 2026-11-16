// A sheet's presence over Yjs awareness: it publishes this window's identity and cursor, and hands the grid every
// peer's cursor to draw. The sheet editor calls it once, and calls the callback it returns when the selection changes.

import { userColor } from '@workspace/lib/constants/colors';
import type { AuthUser } from '@workspace/lib/types/auth';
import type { PeerPresence, WorkbookInstance } from '@workspace/sheet';
import { presencesFromPeers } from '@workspace/sheet';
import { useAwarenessPeers } from '@workspace/ui/components/collab';
import { useCallback, useEffect, useRef } from 'react';
import type { WebsocketProvider } from 'y-websocket';

type PublishSelection = (sheetId: string, r: number, c: number) => void;

export function usePresence(
    provider: WebsocketProvider | null,
    workbookRef: React.RefObject<WorkbookInstance | null>,
    user: AuthUser | null,
    synced: boolean,
): PublishSelection {
    const lastSelectionRef = useRef<string>('');

    // The hook omits this client, so a same-user entry is the user's other window and shows like any peer.
    const peers = useAwarenessPeers<PeerPresence>(provider);

    useEffect(() => {
        if (!provider || !user || !synced) return;
        provider.awareness.setLocalStateField('user', {
            name: user.name,
            color: userColor(user.id),
            userId: user.id,
        });
    }, [provider, user, synced]);

    useEffect(() => {
        if (!provider || !user || !synced) return;
        workbookRef.current?.setPresences(presencesFromPeers(peers));
    }, [provider, user, synced, workbookRef, peers]);

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
