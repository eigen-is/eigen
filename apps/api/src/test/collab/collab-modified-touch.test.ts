import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { ServerWebSocket } from 'elysia/ws/bun';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import CollabDocument from '../../lib/collab/collabDocument';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { driveGet, drivePost, getTestContext } from '../setup';

// A document's Modified time moves for a content change only: opening and closing it leaves
// the row alone, and an edit the 60 s throttle skipped is stamped at close with its own time.

type SpyConn = ServerWebSocket<undefined> & { readyState: number; sent: Uint8Array[] };

function makeSpyConn(): SpyConn {
    const conn = {
        readyState: 1, // OPEN
        sent: [] as Uint8Array[],
        send(data: Uint8Array) {
            conn.sent.push(data);
        },
        close() {
            conn.readyState = 3;
        },
    };
    return conn as unknown as SpyConn;
}

// MESSAGE_SYNC (0) + payload, the frames a y-websocket client sends (mirrors collabDocument.ts).
function syncFrame(write: (encoder: encoding.Encoder) => void): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    write(encoder);
    return encoding.toUint8Array(encoder);
}

function updateFrame(value: string): Uint8Array {
    const edit = new Y.Doc();
    edit.getMap('modified-touch-test').set('k', value);
    return syncFrame((encoder) => syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(edit)));
}

describe('CollabDocument Modified touch', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let home: Home;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        home = await getHome(ctx.alice.user.id);
    });

    async function openTouchedDoc(fileName: string) {
        const docPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName },
        );
        const { path } = await home.drive.resolveFile(mountId, docPath.id);

        const touches: Date[] = [];
        const original = home.drive.touchUpdatedAt.bind(home.drive);
        home.drive.touchUpdatedAt = async (...args: Parameters<typeof original>) => {
            if (args[1] === path.id) touches.push(args[2]);
            return original(...args);
        };

        const doc = new CollabDocument(home.drive, path);
        await doc.init();
        const conn = makeSpyConn();
        doc.subscribe(home.user, conn);
        return {
            doc,
            conn,
            touches,
            restore: () => {
                home.drive.touchUpdatedAt = original;
            },
        };
    }

    test('a handshake and awareness without an update never touch, not even at close', async () => {
        const { doc, conn, touches, restore } = await openTouchedDoc('touch-handshake');
        try {
            // A writer's y-websocket handshake from an empty client doc: step 1, then step 2
            // against the server's state vector, then its presence.
            const client = new Y.Doc();
            doc.handleMessage(
                conn,
                syncFrame((encoder) => syncProtocol.writeSyncStep1(encoder, client)),
                true,
            );
            doc.handleMessage(
                conn,
                syncFrame((encoder) => syncProtocol.writeSyncStep2(encoder, client, Y.encodeStateVector(doc.doc))),
                true,
            );
            const awareness = new awarenessProtocol.Awareness(client);
            awareness.setLocalState({ user: { userId: home.user.id, name: home.user.name } });
            const presence = encoding.createEncoder();
            encoding.writeVarUint(presence, 1); // MESSAGE_AWARENESS
            encoding.writeVarUint8Array(
                presence,
                awarenessProtocol.encodeAwarenessUpdate(awareness, [client.clientID]),
            );
            doc.handleMessage(conn, encoding.toUint8Array(presence), true);
            awareness.destroy();

            doc.unsubscribe(conn);
            doc.destruct();
            expect(touches).toHaveLength(0);
        } finally {
            restore();
            doc.destruct();
        }
    });

    test('an update from a read-only connection never touches', async () => {
        const { doc, conn, touches, restore } = await openTouchedDoc('touch-read-only');
        try {
            doc.handleMessage(conn, updateFrame('dropped'), false);
            expect(touches).toHaveLength(0);

            doc.destruct();
            expect(touches).toHaveLength(0);
        } finally {
            restore();
            doc.destruct();
        }
    });

    test('one update touches at once and adds no touch at close', async () => {
        const { doc, conn, touches, restore } = await openTouchedDoc('touch-single');
        try {
            doc.handleMessage(conn, updateFrame('one'), true);
            expect(touches).toHaveLength(1);

            doc.destruct();
            expect(touches).toHaveLength(1);
        } finally {
            restore();
            doc.destruct();
        }
    });

    test('an update inside the throttle is stamped at close with its own time', async () => {
        const { doc, conn, touches, restore } = await openTouchedDoc('touch-trailing');
        try {
            doc.handleMessage(conn, updateFrame('one'), true);
            expect(touches).toHaveLength(1);

            const before = Date.now();
            doc.handleMessage(conn, updateFrame('two'), true);
            const after = Date.now();
            expect(touches).toHaveLength(1);

            // The linger puts the close well after the edit; the stamp must not move with it.
            await Bun.sleep(50);
            doc.destruct();
            expect(touches).toHaveLength(2);
            expect(touches[1].getTime()).toBeGreaterThanOrEqual(before);
            expect(touches[1].getTime()).toBeLessThanOrEqual(after);
        } finally {
            restore();
            doc.destruct();
        }
    });

    test('a touch writes the time it is given to the row', async () => {
        const docPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'touch-stamp' },
        );
        const stamp = new Date('2026-01-05T14:30:00Z');
        await home.drive.touchUpdatedAt(mountId, docPath.id, stamp);
        const { path } = await home.drive.resolveFile(mountId, docPath.id);
        expect(path.updatedAt.getTime()).toBe(stamp.getTime());
    });
});
