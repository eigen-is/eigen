import type {ServerWebSocket} from "bun";
import type {User} from "better-auth/types";

export function keepWebSocketAlive(user: User, ws: ServerWebSocket, onClose: () => void) {
    const pingInterval = setInterval(() => {
        if (ws.readyState === 1) { // OPEN
            try {
                ws.ping();
            } catch (err) {
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
}