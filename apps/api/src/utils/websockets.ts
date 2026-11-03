// Keeps a server WebSocket alive with a ping every 15 seconds, such as a collab editor's socket. A proxy then
// keeps the connection. A socket that has closed, or whose ping fails, is cleaned up through the onClose its
// route passes.

import type { ServerWebSocket } from 'elysia/ws/bun';
import type { User } from '../lib/user';

export function keepWebSocketAlive(
    user: User,
    ws: ServerWebSocket<unknown>,
    onClose: () => void,
): ReturnType<typeof setInterval> {
    const stop = (reason: string) => {
        clearInterval(pingInterval);
        console.log(`${reason}, closing connection for user ${user.id}`);
        onClose();
    };
    const pingInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
            stop('Socket no longer open');
            return;
        }
        try {
            ws.ping();
        } catch {
            stop('Ping failed');
        }
    }, 15000);
    return pingInterval;
}
