import { COLLAB_STORAGE_UNAVAILABLE_CLOSE, COLLAB_STORAGE_UNAVAILABLE_REASON } from '@workspace/lib/constants/collab';
import type { ServerWebSocket } from 'elysia/ws/bun';

// Every open collab socket, grouped by the home that owns the document it edits. A CollabDocument
// keeps its own connections, but they live in the owner's Drive registry — which a restore has just
// evicted — so the sockets are tracked here, next to the route that opens them, and a restore can
// still reach them. Registered on open, dropped on close.
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
