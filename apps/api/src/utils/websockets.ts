// Keeps a server WebSocket alive with a ping every 15 seconds, such as a collab editor's socket. A proxy then
// keeps the connection, and a socket whose ping fails is cleaned up through the onClose its route passes.

import type { ServerWebSocket } from 'elysia/ws/bun';
import type { User } from '../lib/user';

export function keepWebSocketAlive(
    user: User,
    ws: ServerWebSocket<unknown>,
    onClose: () => void,
): ReturnType<typeof setInterval> {
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.ping();
            } catch {
                clearInterval(pingInterval);
                console.log(`Ping failed, closing connection for user ${user.id}`);
                onClose();
            }
        } else {
            clearInterval(pingInterval);
            console.log(`Ping failed, closing connection for user ${user.id}`);
            onClose();
        }
    }, 15000);
    return pingInterval;
}
