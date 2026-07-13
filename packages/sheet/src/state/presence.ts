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
// Peers sharing the local user's id are skipped so a user never sees — or fights
// across tabs — their own cursor.
export function presencesFromPeers(peers: PeerPresence[], selfUserId: string): Presence[] {
    const result: Presence[] = [];
    for (const { user, selection } of peers) {
        if (!user || !selection) continue;
        if (user.userId != null && user.userId === selfUserId) continue;
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
