import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { FileEvent } from '@workspace/lib/types/file-history';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { getHome } from '../../lib/home';
import { authedRequest, drivePost, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

// A genuine Yjs sync-update frame (MESSAGE_SYNC=0 + messageYjsUpdate), the exact
// shape the client sends and CollabDocument.handleMessage applies to the shared doc.
function syncUpdateMessage(value: string): Uint8Array {
    const edit = new Y.Doc();
    edit.getMap('edited-events-test').set('k', value);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); // MESSAGE_SYNC (mirrors collabDocument.ts)
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(edit));
    return encoding.toUint8Array(encoder);
}

async function editedRows(token: string, ownerId: string, mountId: string, pathId: string): Promise<FileEvent[]> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/path/${pathId}/history`);
    expect(res.status).toBe(200);
    const events = (await res.json()) as FileEvent[];
    return events.filter((e) => e.eventType === 'edited');
}

// Poll the history endpoint: recordFileEvent is fire-and-forget off the doc 'update'
// handler, so the row lands a few async ticks after the WS send.
async function waitForEditedRows(
    token: string,
    ownerId: string,
    mountId: string,
    pathId: string,
    timeoutMs = 3000,
): Promise<FileEvent[]> {
    const deadline = Date.now() + timeoutMs;
    let rows = await editedRows(token, ownerId, mountId, pathId);
    while (rows.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        rows = await editedRows(token, ownerId, mountId, pathId);
    }
    return rows;
}

// A real Bun WebSocket client carrying Alice's session cookie in the upgrade request.
function openCollabWs(
    port: number,
    ownerId: string,
    mountId: string,
    pathId: string,
    token: string,
): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${port}/ws/collab/${ownerId}/${mountId}/${pathId}`, {
        headers: { cookie: `better-auth.session_token=${token}` },
    } as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
        ws.onopen = () => resolve(ws);
        ws.onerror = (e) => reject(e);
    });
}

// Bun's WebSocket.send takes a Uint8Array at runtime; the DOM lib types want a stricter
// ArrayBuffer-backed view, hence the single cast here.
function sendBytes(sock: WebSocket, bytes: Uint8Array): void {
    sock.send(bytes as unknown as ArrayBuffer);
}

// Needs a real listening server: only a genuine WS upgrade through Elysia's Bun adapter
// allocates the per-event ElysiaWS wrappers whose identity mismatch this fix addresses;
// app.handle() never completes the upgrade.
describe('Collab edited file-events', () => {
    let ctx: TestCtx;
    let ownerId: string;
    let mountId: string;
    let token: string;
    let docId: string;
    let stickiesId: string;
    let port: number;
    let ws: WebSocket;
    let stickiesWs: WebSocket;

    beforeAll(async () => {
        ctx = await getTestContext();
        ownerId = ctx.alice.user.id;
        token = ctx.alice.user.sessionToken;

        const { data: mounts } = await ctx.alice.api.drive({ ownerId }).mounts.get();
        mountId = mounts![0].id;
        const rootRes = await authedRequest(token, `/drive/${ownerId}/${mountId}/root`);
        const root = (await rootRes.json()) as { id: string };

        const doc = await drivePost(token, ownerId, mountId, `folder/${root.id}/create/doc`, {
            fileName: 'Edited Events Doc',
        });
        docId = doc.id;

        const board = await drivePost(token, ownerId, mountId, `folder/${root.id}/create/stickies`, {
            fileName: 'Edited Events Board',
        });
        stickiesId = board.id;

        const server = ctx.app.listen(0);
        const listenPort = server.server?.port;
        expect(listenPort).toBeDefined();
        port = listenPort!;
        ws = await openCollabWs(port, ownerId, mountId, docId, token);
        stickiesWs = await openCollabWs(port, ownerId, mountId, stickiesId, token);
    });

    afterAll(() => {
        try {
            ws?.close();
        } catch {}
        try {
            stickiesWs?.close();
        } catch {}
        ctx.app.stop();
    });

    test('a real Yjs update over the WS records exactly one edited row attributed to alice', async () => {
        sendBytes(ws, syncUpdateMessage('one'));

        const rows = await waitForEditedRows(token, ownerId, mountId, docId);
        expect(rows).toHaveLength(1);
        expect(rows[0].actorEmail).toBe('alice@test.eigen.is');
        expect(rows[0].actorUserId).toBe(ownerId);
    });

    test('a second update within the throttle window does NOT add a second edited row', async () => {
        sendBytes(ws, syncUpdateMessage('two'));
        // Give the update + any (throttled) record attempt time to settle.
        await new Promise((r) => setTimeout(r, 500));

        const rows = await editedRows(token, ownerId, mountId, docId);
        expect(rows).toHaveLength(1);
    });

    test('a real Yjs update on a stickies board records NO edited row (its activity is fully specific)', async () => {
        sendBytes(stickiesWs, syncUpdateMessage('board-edit'));
        // Same WS mechanism as the eigendoc above, but a stickies board must NOT get a
        // generic 'edited' row. Settle, then assert none landed.
        await new Promise((r) => setTimeout(r, 500));

        const rows = await editedRows(token, ownerId, mountId, stickiesId);
        expect(rows).toHaveLength(0);
    });

    test('a clean disconnect drops the connection and leaves history intact', async () => {
        const home = await getHome(ownerId);
        const collab = await home.drive.getCollabDocument(mountId, docId);
        expect(collab.connectionCount).toBeGreaterThanOrEqual(1);

        const closed = new Promise<void>((resolve) => {
            ws.onclose = () => resolve();
        });
        ws.close();
        await closed;
        // Let the server-side close handler run unsubscribe on the raw socket.
        await new Promise((r) => setTimeout(r, 200));
        expect(collab.connectionCount).toBe(0);

        // A reconnect + update after the disconnect must not crash the session.
        const ws2 = await openCollabWs(port, ownerId, mountId, docId, token);
        sendBytes(ws2, syncUpdateMessage('three'));
        await new Promise((r) => setTimeout(r, 200));
        expect(ws2.readyState).toBe(WebSocket.OPEN);
        ws2.close();

        // History survives the disconnect (>=1 edited row). Closing the last connection tears
        // the doc down, so the reopen resets the per-instance edit throttle — an extra row here
        // is the accepted spec trade-off (see EDIT_RECORD_THROTTLE_MS), not a leak.
        const rows = await editedRows(token, ownerId, mountId, docId);
        expect(rows.length).toBeGreaterThanOrEqual(1);
    });
});
