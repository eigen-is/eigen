import { beforeAll, describe, expect, test } from 'bun:test';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

// Regression net for collab/Yjs audit finding #5 (deep-dive doc removed — see git history): app.ts
// must keep an explicit maxPayloadLength on the root websocket config — Bun's
// default is 16 MB, enforced on RECEIVED (client→server) frames against the
// DECODED size, and perMessageDeflate does not raise the ceiling (verified: a
// fully-compressible 17 MB message on a deflate-negotiated socket is still
// killed). Outgoing server→client frames (the initial-sync whole-state
// syncStep2) are NOT limited.
//
// The realistic oversized client→server frame is sheets' flushSnapshot
// (use-sheet.ts): the whole workbook JSON lands in ONE Yjs update = ONE WS frame
// on tab close/unmount and rides ~48 bytes above the JSON size. Measured with
// full cell JSON: ~2.9 MB @ 26k cells, ~16.7 MB @ 150k cells, ~44.5 MB @ 400k
// cells (the ~48 MB case blob-codec.ts documents from production). When the
// frame is killed, the client sees an abnormal close (1006) and — on page
// unload — the flush is simply gone; the server keeps snapshot_old + the ops
// rows, so the sheet's state.snapshot never consolidates and the ops array
// grows without bound.
//
// These tests pin the contract through the exact websocket options app.ts
// passes to Bun.serve (Elysia forwards app.config.websocket verbatim).

const MESSAGE_SYNC = 0;

// The frame y-websocket sends for a flushSnapshot transaction: one update
// carrying the whole workbook JSON inside state.snapshot.
function sheetFlushFrame(jsonBytes: number): Uint8Array<ArrayBuffer> {
    const doc = new Y.Doc();
    let update: Uint8Array | undefined;
    doc.on('update', (u: Uint8Array) => {
        update = u;
    });
    doc.transact(() => {
        doc.getMap('state').set('snapshot', 'c'.repeat(jsonBytes));
    });
    doc.destroy();
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update!);
    const encoded = encoding.toUint8Array(encoder);
    // Re-back on a plain ArrayBuffer: WebSocket.send wants BufferSource.
    const frame = new Uint8Array(encoded.byteLength);
    frame.set(encoded);
    return frame;
}

type WireResult = { delivered: number | null; closeCode: number | null };

// Round-trip a frame through a Bun.serve running the given websocket options.
// c2s: client sends, server acks receipt; s2c: server sends on open, client
// reports what arrived. Resolves on the socket close either way.
async function throughWebSocket(
    wsOptions: Record<string, unknown>,
    frame: Uint8Array<ArrayBuffer>,
    direction: 'c2s' | 's2c',
): Promise<WireResult> {
    let delivered: number | null = null;
    const server = Bun.serve({
        port: 0,
        fetch(req, srv) {
            if (srv.upgrade(req)) return;
            return new Response(null, { status: 400 });
        },
        websocket: {
            ...wsOptions,
            open(ws: { send: (d: Uint8Array) => void }) {
                if (direction === 's2c') ws.send(frame);
            },
            message(ws: { send: (d: string) => void }, message: string | Uint8Array) {
                delivered = typeof message === 'string' ? message.length : message.byteLength;
                ws.send('ack');
            },
        },
    });

    const closeCode = await new Promise<number | null>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${server.port}`);
        ws.binaryType = 'arraybuffer';
        const timer = setTimeout(() => {
            try {
                ws.close();
            } catch {}
            resolve(null);
        }, 20_000);
        ws.onopen = () => {
            if (direction === 'c2s') ws.send(frame);
        };
        ws.onmessage = (ev) => {
            if (direction === 's2c') delivered = (ev.data as ArrayBuffer).byteLength;
            ws.close(1000, 'done');
        };
        ws.onclose = (ev) => {
            clearTimeout(timer);
            resolve(ev.code);
        };
    });

    server.stop(true);
    return { delivered, closeCode };
}

describe('Collab WS payload limits (audit finding #5)', () => {
    let appWsOptions: Record<string, unknown>;

    beforeAll(async () => {
        const ctx: TestCtx = await getTestContext();
        // The seam Elysia hands to Bun.serve — only root-instance config counts.
        appWsOptions = (ctx.app.config as { websocket?: Record<string, unknown> }).websocket ?? {};
    });

    test('a mid-size sheet flush frame (4 MB) is delivered under the app websocket config', async () => {
        const frame = sheetFlushFrame(4 * 1024 * 1024);
        const result = await throughWebSocket(appWsOptions, frame, 'c2s');
        expect(result.delivered).toBe(frame.byteLength);
        expect(result.closeCode).toBe(1000);
    }, 30_000);

    test('the initial-sync direction (server→client whole state) is not payload-limited', async () => {
        const frame = sheetFlushFrame(20 * 1024 * 1024);
        const result = await throughWebSocket(appWsOptions, frame, 's2c');
        expect(result.delivered).toBe(frame.byteLength);
    }, 30_000);

    // The finding itself: a ~150k-cell sheet's flushSnapshot frame (>16 MB)
    // must survive the app websocket config. Under Bun's 16 MB default this
    // killed the socket (abnormal 1006 close) and the flush was lost — RED
    // until app.ts set maxPayloadLength sized for the documented ~48 MB worst
    // case (128 MB).
    test('a large sheet flush frame (20 MB) must survive the app websocket config', async () => {
        const frame = sheetFlushFrame(20 * 1024 * 1024);
        const result = await throughWebSocket(appWsOptions, frame, 'c2s');
        expect(result.delivered).toBe(frame.byteLength);
        expect(result.closeCode).toBe(1000);
    }, 30_000);
});
