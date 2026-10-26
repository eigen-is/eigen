// Every open collab socket, grouped by the home that owns the document it edits. A CollabDocument
// keeps its own connections, but a backup restore evicts the owner's Drive, and its documents with it.
// So the route also registers each socket here when it opens and drops it when it closes, and a
// restore can still close every socket of the home.

import { COLLAB_STORAGE_UNAVAILABLE_CLOSE, COLLAB_STORAGE_UNAVAILABLE_REASON } from '@workspace/lib/constants/collab';
import type { ServerWebSocket } from 'elysia/ws/bun';

const connectionsByOwner = new Map<string, Set<ServerWebSocket<unknown>>>();

export function registerCollabConnection(ownerId: string, ws: ServerWebSocket<unknown>): void {
    let sockets = connectionsByOwner.get(ownerId);
    if (!sockets) {
        sockets = new Set();
        connectionsByOwner.set(ownerId, sockets);
    }
    sockets.add(ws);
}

export function unregisterCollabConnection(ownerId: string, ws: ServerWebSocket<unknown>): void {
    const sockets = connectionsByOwner.get(ownerId);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) connectionsByOwner.delete(ownerId);
}

// Close every collab socket on this home because its folder is about to be replaced. The retry close keeps the
// tab's document: once the restore is done its reconnect names the old data epoch and the tab reloads, and after a
// failed restore the reconnect syncs the edits it holds.
export function closeCollabConnectionsForHome(ownerId: string): void {
    const sockets = connectionsByOwner.get(ownerId);
    if (!sockets) return;
    connectionsByOwner.delete(ownerId);
    for (const ws of sockets) ws.close(COLLAB_STORAGE_UNAVAILABLE_CLOSE, COLLAB_STORAGE_UNAVAILABLE_REASON);
}
