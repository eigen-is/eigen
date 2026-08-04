import type { ServerWebSocket } from 'bun';
import * as encoding from 'lib0/encoding';
import { MESSAGE_AWARENESS } from './collabDocument';

// y-websocket hard-closes a connection that stays silent for 30s (a hardcoded
// client constant) and reconnects on a ~2.5s backoff. A cold open of a large doc
// (home init + S3 download + main-thread materialization) can stay silent longer
// than that, and every retry re-pays the full load — a self-sustaining spiral that
// degraded the whole server (2026-08-04 incident). So the WS route speaks first:
// an empty awareness frame immediately and on an interval, until sync-step-1
// takes over. Clients apply it as a no-op; it only resets their silence timer.
const LOADING_HEARTBEAT_MS = 10_000;

function encodeEmptyAwarenessMessage(): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    // An awareness update declaring zero clients.
    encoding.writeVarUint8Array(encoder, new Uint8Array([0]));
    return encoding.toUint8Array(encoder);
}

const EMPTY_AWARENESS_MESSAGE = encodeEmptyAwarenessMessage();

export function startLoadingHeartbeat(conn: ServerWebSocket<undefined>, intervalMs = LOADING_HEARTBEAT_MS): () => void {
    const send = () => {
        if (conn.readyState === 1) conn.send(Buffer.from(EMPTY_AWARENESS_MESSAGE));
    };
    send();
    const timer = setInterval(send, intervalMs);
    return () => clearInterval(timer);
}
