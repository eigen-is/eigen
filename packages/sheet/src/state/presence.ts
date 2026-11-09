// A peer's awareness state as the cursor the grid draws for it. The sheet app's presence hook hands the live peers
// through here to the workbook, which draws each row over its cell.

import type { Presence } from './types';

// What a sheet's window publishes over awareness, of which presence reads two fields.
export type PeerPresence = {
    user?: { name: string; color: string; userId?: string };
    selection?: { sheetId: string; r: number; c: number };
};

// Peers with both an identity and a cursor become rows, one per awareness client. A same-user entry is their other
// window, shown like a peer.
export function presencesFromPeers(peers: ReadonlyMap<number, PeerPresence>): Presence[] {
    const result: Presence[] = [];
    for (const [clientId, { user, selection }] of peers) {
        if (!user || !selection) continue;
        result.push({
            clientId,
            sheetId: selection.sheetId,
            username: user.name,
            userId: user.userId,
            color: user.color,
            selection: { r: selection.r, c: selection.c },
        });
    }
    return result;
}
