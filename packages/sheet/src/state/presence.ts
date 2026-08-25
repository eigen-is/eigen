import type { Presence } from './types';

// A collaborator's published awareness snapshot, reduced to the two fields
// presence needs. The app extracts these from the Yjs provider's awareness
// states; the projection to `Presence` lives here next to the `Presence` type so
// it can be unit-tested without a browser or provider.
export type PeerPresence = {
    user?: { name: string; color: string; userId?: string };
    selection?: { sheetId: string; r: number; c: number };
};

// Peers that have published both an identity and a cursor become `Presence` rows.
// The local TAB is already absent (useAwarenessPeers omits the local client), so a
// same-user entry here is the user's other window — shown like any peer, unified
// with the other apps (Reinder ruling 2026-08-24: you see yourself across windows).
export function presencesFromPeers(peers: PeerPresence[]): Presence[] {
    const result: Presence[] = [];
    for (const { user, selection } of peers) {
        if (!user || !selection) continue;
        result.push({
            sheetId: selection.sheetId,
            username: user.name,
            userId: user.userId,
            color: user.color,
            selection: { r: selection.r, c: selection.c },
        });
    }
    return result;
}
