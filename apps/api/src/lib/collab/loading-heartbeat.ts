// Keeps a collab socket from going silent while its document loads. y-websocket closes a socket that
// stays silent for 30 s and connects again, and a cold open of a large document can take longer. Each
// retry would pay the whole load again, so the route sends an empty awareness frame right away and
// every 10 s until the sync starts. A client applies it as a no-op.

import type { ServerWebSocket } from 'elysia/ws/bun';
import * as encoding from 'lib0/encoding';
import { MESSAGE_AWARENESS } from './collab-document';

const LOADING_HEARTBEAT_MS = 10_000;

function encodeEmptyAwarenessMessage(): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    // An awareness update declaring zero clients.
    encoding.writeVarUint8Array(encoder, new Uint8Array([0]));
    return encoding.toUint8Array(encoder);
}

const EMPTY_AWARENESS_MESSAGE = encodeEmptyAwarenessMessage();

export function startLoadingHeartbeat(conn: ServerWebSocket<unknown>, intervalMs = LOADING_HEARTBEAT_MS): () => void {
    const send = () => {
        if (conn.readyState === WebSocket.OPEN) conn.send(Buffer.from(EMPTY_AWARENESS_MESSAGE));
    };
    send();
    const timer = setInterval(send, intervalMs);
    return () => clearInterval(timer);
}
