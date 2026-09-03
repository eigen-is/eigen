import type { ServerWebSocket } from 'bun';
import type { User } from '../lib/user';

export function keepWebSocketAlive(
    user: User,
    ws: ServerWebSocket,
    onClose: () => void,
    onTick?: () => void,
): ReturnType<typeof setInterval> {
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.ping();
            } catch {
                clearInterval(pingInterval);
                console.log(`Ping failed, closing connection for user ${user.id}`);
                onClose();
                return;
            }
            // Only pin liveness once the socket has proven still open — a failed ping never reaches here.
            onTick?.();
        } else {
            clearInterval(pingInterval);
            console.log(`Ping failed, closing connection for user ${user.id}`);
            onClose();
        }
    }, 15000);
    return pingInterval;
}
