import type { AuthUser } from '@workspace/lib/auth';
import { userColor } from '@workspace/lib/constants/colors';
import { type PeerPresence, presencesFromPeers, type WorkbookInstance } from '@workspace/sheet';
import { useCallback, useEffect, useRef } from 'react';
import type { WebsocketProvider } from 'y-websocket';

type PresenceAwarenessState = {
    user?: { name: string; color: string; userId: string };
    selection?: { sheetId: string; r: number; c: number };
};

export type PublishSelection = (sheetId: string, r: number, c: number) => void;

// Wires Yjs awareness into the workbook's presence API: publishes the local user
// identity + cursor, and mirrors every peer's cursor into addPresences/removePresences.
// Returns a publishSelection callback the editor calls from the Workbook's
// afterSelectionChange hook.
export function usePresence(
    provider: WebsocketProvider | null,
    workbookRef: React.RefObject<WorkbookInstance | null>,
    user: AuthUser | null,
    synced: boolean,
): PublishSelection {
    const lastSelectionRef = useRef<string>('');

    useEffect(() => {
        // Gate on synced so the workbook is mounted (workbookRef.current set) before
        // we start pushing presences; synced implies the provider is non-null.
        if (!provider || !user || !synced) return;
        const { awareness } = provider;
        const selfUserId = user.id;
        // clientId -> identity, so a `removed` client (whose state is already gone
        // from getStates()) can be translated back into a removePresences() key.
        const identities = new Map<number, { username: string; userId?: string }>();

        awareness.setLocalStateField('user', { name: user.name, color: userColor(selfUserId), userId: selfUserId });
        lastSelectionRef.current = '';

        const apply = (clientIds: number[]) => {
            const workbook = workbookRef.current;
            if (!workbook) return;
            const states = awareness.getStates();
            const peers: PeerPresence[] = [];
            for (const clientId of clientIds) {
                const state = states.get(clientId) as PresenceAwarenessState | undefined;
                if (!state) continue;
                if (state.user) identities.set(clientId, { username: state.user.name, userId: state.user.userId });
                peers.push({ user: state.user, selection: state.selection });
            }
            const toAdd = presencesFromPeers(peers, selfUserId);
            if (toAdd.length > 0) workbook.addPresences(toAdd);
        };

        const remove = (clientIds: number[]) => {
            const toRemove: { username: string; userId?: string }[] = [];
            for (const clientId of clientIds) {
                const identity = identities.get(clientId);
                if (identity) {
                    toRemove.push(identity);
                    identities.delete(clientId);
                }
            }
            if (toRemove.length > 0) workbookRef.current?.removePresences(toRemove);
        };

        const onChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
            apply([...added, ...updated]);
            remove(removed);
        };

        // Capture peers already connected before this listener attached.
        apply([...awareness.getStates().keys()]);
        awareness.on('change', onChange);

        return () => {
            awareness.off('change', onChange);
        };
    }, [provider, workbookRef, user, synced]);

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
