import type { Presence } from './types';

// A collaborator's awareness snapshot, reduced to the two fields presence needs.
export type PeerPresence = {
    user?: { name: string; color: string; userId?: string };
    selection?: { sheetId: string; r: number; c: number };
};

// Peers with both an identity and a cursor become rows. A same-user entry is their other window, shown like a peer.
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
