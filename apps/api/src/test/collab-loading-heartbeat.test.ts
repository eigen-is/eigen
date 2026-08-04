import { describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import * as decoding from 'lib0/decoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { startLoadingHeartbeat } from '../lib/collab/loading-heartbeat';

// The WS route speaks BEFORE the doc load: y-websocket hard-closes after 30s
// without a message (a hardcoded client constant) and retries on a ~2.5s backoff,
// so a cold load that stays silent past 30s becomes a self-sustaining reconnect
// spiral — every retry re-pays the full load (2026-08-04 prod incident). The
// heartbeat is the unit the route wires in open(); the upgrade itself can't
// complete under app.handle(), so it is pinned here at its seam.

type SpyConn = ServerWebSocket<undefined> & { readyState: number; sent: Uint8Array[] };

function makeSpyConn(): SpyConn {
    const conn = {
        readyState: 1, // OPEN
        sent: [] as Uint8Array[],
        send(data: Uint8Array) {
            conn.sent.push(data);
        },
    };
    return conn as unknown as SpyConn;
}

describe('startLoadingHeartbeat', () => {
    test('sends a first frame immediately and repeats until stopped', async () => {
        const conn = makeSpyConn();
        const stop = startLoadingHeartbeat(conn, 20);
        expect(conn.sent.length).toBe(1);

        await Bun.sleep(70);
        expect(conn.sent.length).toBeGreaterThanOrEqual(3);

        stop();
        const after = conn.sent.length;
        await Bun.sleep(50);
        expect(conn.sent.length).toBe(after);
    });

    test('the frame is a protocol-valid empty awareness update — a no-op for the client', () => {
        const conn = makeSpyConn();
        startLoadingHeartbeat(conn, 60_000)();

        const decoder = decoding.createDecoder(conn.sent[0]);
        expect(decoding.readVarUint(decoder)).toBe(1); // MESSAGE_AWARENESS
        const payload = decoding.readVarUint8Array(decoder);

        // A fresh Awareness always carries its own local client state; applying the
        // heartbeat must leave the state set untouched.
        const awareness = new awarenessProtocol.Awareness(new Y.Doc());
        const statesBefore = awareness.getStates().size;
        expect(() => awarenessProtocol.applyAwarenessUpdate(awareness, payload, null)).not.toThrow();
        expect(awareness.getStates().size).toBe(statesBefore);
        awareness.destroy();
    });

    test('stops sending once the socket is no longer open', async () => {
        const conn = makeSpyConn();
        const stop = startLoadingHeartbeat(conn, 20);
        conn.readyState = 3; // CLOSED

        await Bun.sleep(70);
        expect(conn.sent.length).toBe(1);
        stop();
    });
});
