import { beforeAll, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'elysia/ws/bun';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { MESSAGE_SYNC } from '../../lib/collab/collabDocument';
import { getHome } from '../../lib/home/get-home';
import { driveGet, drivePost, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

// Bun negotiates permessage-deflate but only deflates a frame when send() gets compress=true, so the
// spy records that flag.
type SpyConn = ServerWebSocket<undefined> & {
    readyState: number;
    sent: { bytes: number; compress: boolean | undefined }[];
};

function makeSpyConn(): SpyConn {
    const conn = {
        readyState: 1, // OPEN
        sent: [] as { bytes: number; compress: boolean | undefined }[],
        send(data: Uint8Array, compress?: boolean) {
            conn.sent.push({ bytes: data.byteLength, compress });
        },
        close() {
            conn.readyState = 3; // CLOSED
        },
    };
    return conn as unknown as SpyConn;
}

function updateFrame(text: string): Uint8Array {
    const doc = new Y.Doc();
    doc.getMap('state').set(crypto.randomUUID(), text);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
    doc.destroy();
    return encoding.toUint8Array(encoder);
}

// What a fresh y-websocket client sends: sync step 1 with an empty state vector.
function syncStep1Frame(): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, new Y.Doc());
    return encoding.toUint8Array(encoder);
}

describe('Collab frame compression', () => {
    let ctx: TestCtx;
    let aliceMountId: string;
    let docId: string;

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
            { fileName: 'Frame Compression Doc' },
        );
        docId = doc.id;
    });

    test('large frames go out compressed, small ones raw', async () => {
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(aliceMountId, docId);
        const writer = makeSpyConn();
        const peer = makeSpyConn();
        collab.subscribe(home.user, writer);
        collab.subscribe(home.user, peer);
        try {
            peer.sent.length = 0;
            collab.handleMessage(writer, updateFrame('x'.repeat(64 * 1024)), true);
            collab.handleMessage(writer, updateFrame('y'), true);
            expect(peer.sent.map((f) => f.compress)).toEqual([true, false]);

            const joiner = makeSpyConn();
            collab.subscribe(home.user, joiner);
            joiner.sent.length = 0;
            collab.handleMessage(joiner, syncStep1Frame(), true);
            expect(joiner.sent).toHaveLength(1);
            expect(joiner.sent[0].bytes).toBeGreaterThan(64 * 1024);
            expect(joiner.sent[0].compress).toBe(true);
            collab.unsubscribe(joiner);
        } finally {
            collab.unsubscribe(writer);
            collab.unsubscribe(peer);
        }
    });
});
