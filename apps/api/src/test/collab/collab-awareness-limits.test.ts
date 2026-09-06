import { beforeAll, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import * as encoding from 'lib0/encoding';

import { getHome } from '../../lib/home/get-home';
import { driveGet, drivePost, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

// A ServerWebSocket stand-in the CollabDocument can subscribe/broadcast on, mirroring collab.test.ts.
type SpyConn = ServerWebSocket<undefined> & { readyState: number; sent: unknown[] };

function makeSpyConn(): SpyConn {
    const conn = {
        readyState: 1, // OPEN
        sent: [] as unknown[],
        send(data: unknown) {
            conn.sent.push(data);
        },
        close() {
            conn.readyState = 3; // CLOSED
        },
    };
    return conn as unknown as SpyConn;
}

// Encode a MESSAGE_AWARENESS frame with full control over the entries on the wire — the layout
// y-protocols' encodeAwarenessUpdate produces: len, then per entry clientId, clock, JSON state.
function awarenessFrame(entries: { clientId: number; clock: number; state: unknown }[]): Uint8Array {
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, entries.length);
    for (const e of entries) {
        encoding.writeVarUint(inner, e.clientId);
        encoding.writeVarUint(inner, e.clock);
        encoding.writeVarString(inner, JSON.stringify(e.state));
    }
    const outer = encoding.createEncoder();
    encoding.writeVarUint(outer, 1); // MESSAGE_AWARENESS (mirrors collabDocument.ts)
    encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner));
    return encoding.toUint8Array(outer);
}

describe('Collab awareness limits (audit findings #7, #12)', () => {
    let ctx: TestCtx;
    let aliceMountId: string;
    let docId: string;
    let clientIdSeq = 100_000;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        aliceMountId = mounts![0].id;
        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        const doc = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${root.id}/create/doc`,
            { fileName: 'Awareness Limits Doc' },
        );
        docId = doc.id;
    });

    test('a frame declaring 200 client ids is dropped: the peer receives nothing', async () => {
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(aliceMountId, docId);
        const send = makeSpyConn();
        const peer = makeSpyConn();
        collab.subscribe(home.user, send);
        collab.subscribe(home.user, peer);
        try {
            const base = peer.sent.length;
            const entries = Array.from({ length: 200 }, () => ({
                clientId: clientIdSeq++,
                clock: 1,
                state: { user: { userId: home.user.id, name: home.user.name, color: '#123456' } },
            }));
            collab.handleMessage(send, awarenessFrame(entries), true);
            expect(peer.sent.length).toBe(base);
        } finally {
            collab.unsubscribe(send);
            collab.unsubscribe(peer);
        }
    });

    test('a state larger than the byte cap is dropped: the peer receives nothing', async () => {
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(aliceMountId, docId);
        const send = makeSpyConn();
        const peer = makeSpyConn();
        collab.subscribe(home.user, send);
        collab.subscribe(home.user, peer);
        try {
            const base = peer.sent.length;
            const frame = awarenessFrame([
                {
                    clientId: clientIdSeq++,
                    clock: 1,
                    state: { user: { userId: home.user.id }, blob: 'x'.repeat(20_000) },
                },
            ]);
            collab.handleMessage(send, frame, true);
            expect(peer.sent.length).toBe(base);
        } finally {
            collab.unsubscribe(send);
            collab.unsubscribe(peer);
        }
    });

    test("a state carrying another user's identity is dropped: the peer receives nothing", async () => {
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(aliceMountId, docId);
        const send = makeSpyConn();
        const peer = makeSpyConn();
        collab.subscribe(home.user, send);
        collab.subscribe(home.user, peer);
        try {
            const base = peer.sent.length;
            const frame = awarenessFrame([
                {
                    clientId: clientIdSeq++,
                    clock: 1,
                    state: { user: { userId: 'someone-else', name: 'Impostor', color: '#ff0000' } },
                },
            ]);
            collab.handleMessage(send, frame, true);
            expect(peer.sent.length).toBe(base);
        } finally {
            collab.unsubscribe(send);
            collab.unsubscribe(peer);
        }
    });

    test('a normal single-id state with the session identity reaches the peer', async () => {
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(aliceMountId, docId);
        const send = makeSpyConn();
        const peer = makeSpyConn();
        collab.subscribe(home.user, send);
        collab.subscribe(home.user, peer);
        try {
            const base = peer.sent.length;
            const frame = awarenessFrame([
                {
                    clientId: clientIdSeq++,
                    clock: 1,
                    state: {
                        user: { userId: home.user.id, name: home.user.name, color: '#123456' },
                        selection: { sheetId: 's1', r: 3, c: 4 },
                    },
                },
            ]);
            collab.handleMessage(send, frame, true);
            expect(peer.sent.length).toBe(base + 1);
        } finally {
            collab.unsubscribe(send);
            collab.unsubscribe(peer);
        }
    });
});
