import type { User } from 'better-auth/types';
import type { ServerWebSocket } from 'bun';

export function keepWebSocketAlive(
    user: User,
    ws: ServerWebSocket,
    onClose: () => void,
): ReturnType<typeof setInterval> {
    const pingInterval = setInterval(() => {
        if (ws.readyState === 1) {
            // OPEN
            try {
                ws.ping();
            } catch (_err) {
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
