import { COLLAB_HOME_REPLACED_CLOSE } from '@workspace/lib/constants/collab';
import type { ServerWebSocket } from 'bun';

// Every open collab socket, grouped by the home that owns the document it edits. A CollabDocument
// keeps its own connections, but they live in the owner's Drive registry — which a restore has just
// evicted — so the sockets are tracked here, next to the route that opens them, and a restore can
// still reach them. Registered on open, dropped on close.
const connectionsByOwner = new Map<string, Set<ServerWebSocket<undefined>>>();

export function registerCollabConnection(ownerId: string, ws: ServerWebSocket<undefined>): void {
    let sockets = connectionsByOwner.get(ownerId);
    if (!sockets) {
        sockets = new Set();
        connectionsByOwner.set(ownerId, sockets);
    }
    sockets.add(ws);
}

export function unregisterCollabConnection(ownerId: string, ws: ServerWebSocket<undefined>): void {
    const sockets = connectionsByOwner.get(ownerId);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) connectionsByOwner.delete(ownerId);
}

// Close every collab socket on this home because its folder is about to be replaced. The close code
// tells the client to reload rather than reconnect: a tab that reattached would sync the document it
// still holds in memory back over the restored copy and silently undo the restore.
export function closeCollabConnectionsForHome(ownerId: string): void {
    const sockets = connectionsByOwner.get(ownerId);
    if (!sockets) return;
    connectionsByOwner.delete(ownerId);
    for (const ws of sockets) ws.close(COLLAB_HOME_REPLACED_CLOSE, 'home-replaced');
}
