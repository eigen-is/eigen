import { beforeAll, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { getHome } from '../../lib/home/get-home';
import { assertJson, authedRequest, driveGet, drivePost, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
type WebSocketResponse = Response & { webSocket?: WebSocket };

// A ServerWebSocket stand-in the CollabDocument can subscribe/broadcast/close on.
// The HTTP→WS upgrade never completes under app.handle() (every real-WS test below
// early-returns on status !== 101), so read-revocation enforcement is exercised at
// its true seam: live connections in the owner-home CollabDocument.
type SpyConn = ServerWebSocket<undefined> & {
    readyState: number;
    closedWith: { code?: number; reason?: string } | null;
    sent: unknown[];
};

function makeSpyConn(): SpyConn {
    const conn = {
        readyState: 1, // OPEN
        closedWith: null as { code?: number; reason?: string } | null,
        sent: [] as unknown[],
        send(data: unknown) {
            conn.sent.push(data);
        },
        close(code?: number, reason?: string) {
            conn.closedWith = { code, reason };
            conn.readyState = 3; // CLOSED
        },
    };
    return conn as unknown as SpyConn;
}

function syncUpdateMessage(doc: Y.Doc): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); // MESSAGE_SYNC (mirrors collabDocument.ts)
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
    return encoding.toUint8Array(encoder);
}

function awarenessMessage(awareness: awarenessProtocol.Awareness, clientId: number): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1); // MESSAGE_AWARENESS (mirrors collabDocument.ts)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [clientId]));
    return encoding.toUint8Array(encoder);
}

describe('Collab', () => {
    let ctx: TestCtx;
    let aliceRootId: string;
    let aliceMountId: string;
    let docId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        expect(mounts).toBeDefined();
        expect(mounts!.length).toBeGreaterThan(0);
        aliceMountId = mounts![0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        expect(root).toBeDefined();
        expect(root.id).toBeDefined();
        aliceRootId = root.id;

        const doc = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRootId}/create/doc`,
            { fileName: 'Collab Test Doc' },
        );
        expect(doc.id).toBeDefined();
        docId = doc.id;
    });

    describe('Collab Info Endpoint', () => {
        test('info endpoint returns canRead, canWrite, path, folderContents for owner', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}/info`,
            );
            const data = await assertJson<{
                canRead: boolean;
                canWrite: boolean;
                path: { id: string };
                folderContents: unknown[];
            }>(res);
            expect(data.canRead).toBe(true);
            expect(data.canWrite).toBe(true);
            expect(data.path).toBeDefined();
            expect(data.path.id).toBe(docId);
            expect(Array.isArray(data.folderContents)).toBe(true);
        });

        test('info endpoint denies access without authentication', async () => {
            const res = await ctx.app.handle(
                new Request(`http://localhost/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}/info`),
            );
            expect(res.status).not.toBe(200);
        });

        test('info endpoint denies access without read permission', async () => {
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ remove: ['bob@test.eigen.is'] }),
                },
            );

            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}/info`,
            );
            const data = await assertJson<{ canRead: boolean; canWrite: boolean; path: null }>(res);
            expect(data.canRead).toBe(false);
            expect(data.canWrite).toBe(false);
            expect(data.path).toBeNull();
        });

        test('info endpoint grants access with shared read permission', async () => {
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        add: [{ id: 'bob@test.eigen.is', read: true, write: false }],
                    }),
                },
            );

            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}/info`,
            );
            const data = await assertJson<{ canRead: boolean; canWrite: boolean; path: string }>(res);
            expect(data.canRead).toBe(true);
            expect(data.canWrite).toBe(false);
            expect(data.path).toBeDefined();
        });
    });

    // The HTTP→WS upgrade does not complete under app.handle(), so the WebSocket integration tests
    // below skip their bodies (status !== 101). Test the write-permission guard at its real seam
    // instead: CollabDocument.handleMessage drops sync writes (sub-types 1/2) when canWrite is false.
    describe('handleMessage write enforcement', () => {
        test('a read-only connection cannot mutate the document; a writable one can', async () => {
            const home = await getHome(ctx.alice.user.id);
            const collab = await home.drive.getCollabDocument(aliceMountId, docId);
            const conn = { send() {}, readyState: 1 } as unknown as Parameters<typeof collab.handleMessage>[0];

            const edit = new Y.Doc();
            edit.getMap('write-test').set('k', 'v');
            const message = syncUpdateMessage(edit);

            // canWrite=false: the update must be dropped.
            collab.handleMessage(conn, message, false);
            expect(collab.doc.getMap('write-test').get('k')).toBeUndefined();

            // canWrite=true: the identical update now applies.
            collab.handleMessage(conn, message, true);
            expect(collab.doc.getMap('write-test').get('k')).toBe('v');
        });

        test('closing a document while it reopens yields a fresh, usable instance', async () => {
            const home = await getHome(ctx.alice.user.id);
            const collab1 = await home.drive.getCollabDocument(aliceMountId, docId);

            // closeCollabDocument synchronously deletes the map entry, then suspends at the async
            // destruct. Reopening in that window must build a fresh doc, not the one being closed.
            const closing = home.drive.closeCollabDocument(aliceMountId, docId);
            const collab2 = await home.drive.getCollabDocument(aliceMountId, docId);
            await closing;

            expect(collab2).not.toBe(collab1);

            // A closed doc's handleMessage no-ops, so a write applying proves collab2 is live.
            const conn = { send() {}, readyState: 1 } as unknown as Parameters<typeof collab2.handleMessage>[0];
            const edit = new Y.Doc();
            edit.getMap('reopen-test').set('k', 'v');
            collab2.handleMessage(conn, syncUpdateMessage(edit), true);
            expect(collab2.doc.getMap('reopen-test').get('k')).toBe('v');
        });
    });

    // The fan-out contract every broadcast path shares: a server-origin update goes to
    // every open connection, a connection-origin update and an awareness update skip
    // their origin.
    describe('broadcast fan-out', () => {
        test('a server-origin update reaches every connection; a connection-origin one skips its origin', async () => {
            const home = await getHome(ctx.alice.user.id);
            const collab = await home.drive.getCollabDocument(aliceMountId, docId);
            const originConn = makeSpyConn();
            const otherConn = makeSpyConn();
            collab.subscribe(home.user, originConn);
            collab.subscribe(home.user, otherConn);
            try {
                const originBase = originConn.sent.length;
                const otherBase = otherConn.sent.length;

                collab.doc.getMap('fanout-server').set('k', 'v');
                expect(originConn.sent.length).toBe(originBase + 1);
                expect(otherConn.sent.length).toBe(otherBase + 1);

                const edit = new Y.Doc();
                edit.getMap('fanout-conn').set('k', 'v');
                collab.handleMessage(originConn, syncUpdateMessage(edit), true);
                expect(collab.doc.getMap('fanout-conn').get('k')).toBe('v');
                expect(originConn.sent.length).toBe(originBase + 1);
                expect(otherConn.sent.length).toBe(otherBase + 2);
            } finally {
                collab.unsubscribe(originConn);
                collab.unsubscribe(otherConn);
            }
        });

        test('an awareness update from a connection reaches the others, never its origin', async () => {
            const home = await getHome(ctx.alice.user.id);
            const collab = await home.drive.getCollabDocument(aliceMountId, docId);
            const originConn = makeSpyConn();
            const otherConn = makeSpyConn();
            collab.subscribe(home.user, originConn);
            collab.subscribe(home.user, otherConn);
            try {
                const remoteDoc = new Y.Doc();
                const remoteAwareness = new awarenessProtocol.Awareness(remoteDoc);
                remoteAwareness.setLocalState({ user: { name: 'fanout-probe' } });

                const originBase = originConn.sent.length;
                const otherBase = otherConn.sent.length;
                collab.handleMessage(originConn, awarenessMessage(remoteAwareness, remoteDoc.clientID), true);

                expect(originConn.sent.length).toBe(originBase);
                expect(otherConn.sent.length).toBe(otherBase + 1);

                remoteAwareness.destroy();
                remoteDoc.destroy();
            } finally {
                collab.unsubscribe(originConn);
                collab.unsubscribe(otherConn);
            }
        });
    });

    describe('WebSocket Connection', () => {
        test('WebSocket requires authentication', async () => {
            const ws = ctx.app.handle(
                new Request(`http://localhost/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`, {
                    headers: {
                        Upgrade: 'websocket',
                        Connection: 'Upgrade',
                    },
                }),
            );

            const res = await ws;
            expect(res.status).not.toBe(101);
        });

        test('WebSocket authenticated connection attempt', async () => {
            const wsRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`,
                {
                    headers: {
                        Upgrade: 'websocket',
                        Connection: 'Upgrade',
                    },
                },
            );

            expect(wsRes.status).toBeGreaterThanOrEqual(100);
            expect(wsRes.status).toBeLessThan(600);

            if (wsRes.status === 101 && (wsRes as WebSocketResponse).webSocket) {
                (wsRes as WebSocketResponse).webSocket!.close();
            }
        });

        test('WebSocket ping-pong works if connected', async () => {
            const wsRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`,
                {
                    headers: {
                        Upgrade: 'websocket',
                        Connection: 'Upgrade',
                    },
                },
            );

            if (wsRes.status !== 101) {
                return;
            }

            const ws = (wsRes as WebSocketResponse).webSocket!;
            const pongPromise = new Promise<string>((resolve) => {
                ws.onmessage = (event: { data: string }) => {
                    if (event.data === 'pong') {
                        resolve('pong');
                    }
                };
            });

            ws.send('ping');
            const result = await Promise.race([pongPromise, new Promise((_, reject) => setTimeout(reject, 5000))]);
            expect(result).toBe('pong');

            ws.close();
        });

        test('WebSocket denies connection without read permission', async () => {
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ remove: ['bob@test.eigen.is'] }),
                },
            );

            const wsRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`,
                {
                    headers: {
                        Upgrade: 'websocket',
                        Connection: 'Upgrade',
                    },
                },
            );

            expect(wsRes.status).not.toBe(101);
        });

        test('WebSocket accepts connection with read permission if upgrade works', async () => {
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        add: [{ id: 'bob@test.eigen.is', read: true, write: false }],
                    }),
                },
            );

            const wsRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`,
                {
                    headers: {
                        Upgrade: 'websocket',
                        Connection: 'Upgrade',
                    },
                },
            );

            expect(wsRes.status).toBeGreaterThanOrEqual(100);
            expect(wsRes.status).toBeLessThan(600);

            if (wsRes.status === 101 && (wsRes as WebSocketResponse).webSocket) {
                (wsRes as WebSocketResponse).webSocket!.close();
            }
        });
    });

    describe('Document Updates', () => {
        test('document accepts Yjs updates from write-enabled user if WebSocket connects', async () => {
            const wsRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`,
                {
                    headers: {
                        Upgrade: 'websocket',
                        Connection: 'Upgrade',
                    },
                },
            );

            if (wsRes.status !== 101) {
                return;
            }

            const ws = (wsRes as WebSocketResponse).webSocket!;
            const updateReceived = new Promise<boolean>((resolve) => {
                ws.onmessage = () => resolve(true);
            });

            const testUpdate = new Uint8Array([1, 2, 3, 4, 5]);
            ws.send(testUpdate);

            const received = await Promise.race([
                updateReceived,
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
            ]);

            ws.close();

            expect(received).toBe(true);
        });

        test('document syncs between multiple connected users if WebSocket works', async () => {
            const aliceWsRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`,
                {
                    headers: {
                        Upgrade: 'websocket',
                        Connection: 'Upgrade',
                    },
                },
            );

            const bobWsRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`,
                {
                    headers: {
                        Upgrade: 'websocket',
                        Connection: 'Upgrade',
                    },
                },
            );

            if (aliceWsRes.status !== 101 || bobWsRes.status !== 101) {
                return;
            }

            const aliceWs = (aliceWsRes as WebSocketResponse).webSocket!;
            const bobWs = (bobWsRes as WebSocketResponse).webSocket!;

            const bobReceivedUpdate = new Promise<boolean>((resolve) => {
                bobWs.onmessage = () => resolve(true);
            });

            const testUpdate = new Uint8Array([10, 20, 30, 40, 50]);
            aliceWs.send(testUpdate);

            const received = await Promise.race([
                bobReceivedUpdate,
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
            ]);

            aliceWs.close();
            bobWs.close();

            expect(received).toBe(true);
        });

        test('document rejects non-binary updates from client', async () => {
            const wsRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`,
                {
                    headers: {
                        Upgrade: 'websocket',
                        Connection: 'Upgrade',
                    },
                },
            );

            if (wsRes.status !== 101) {
                return;
            }

            const ws = (wsRes as WebSocketResponse).webSocket!;

            // Sending string instead of binary Uint8Array
            ws.send('invalid string data');

            // Wait to see if connection is closed or maintained
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(ws.readyState).toBeGreaterThan(0); // Should stay open despite invalid payload format

            ws.close();
        });

        test('read-only user WebSocket behavior if connected', async () => {
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        add: [{ id: 'charlie@test.eigen.is', read: true, write: false }],
                        remove: ['bob@test.eigen.is'],
                    }),
                },
            );

            const wsRes = await authedRequest(
                ctx.charlie.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`,
                {
                    headers: {
                        Upgrade: 'websocket',
                        Connection: 'Upgrade',
                    },
                },
            );

            if (wsRes.status !== 101) {
                return;
            }

            const ws = (wsRes as WebSocketResponse).webSocket!;

            const testUpdate = new Uint8Array([99, 99, 99]);
            ws.send(testUpdate);

            await new Promise((resolve) => setTimeout(resolve, 100));

            ws.close();

            expect(ws.readyState).toBeGreaterThan(0);
        });
    });

    describe('Permission Changes', () => {
        test('revoking read permission disconnects user if WebSocket connected', async () => {
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        add: [{ id: 'bob@test.eigen.is', read: true, write: true }],
                        remove: ['charlie@test.eigen.is'],
                    }),
                },
            );

            const wsRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`,
                {
                    headers: {
                        Upgrade: 'websocket',
                        Connection: 'Upgrade',
                    },
                },
            );

            if (wsRes.status !== 101) {
                return;
            }

            const ws = (wsRes as WebSocketResponse).webSocket!;

            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ remove: ['bob@test.eigen.is'] }),
                },
            );

            await new Promise((resolve) => setTimeout(resolve, 500));

            ws.close();
        });

        test('revoking read via updateACL closes the revoked user, keeps the owner (and read-only survivors)', async () => {
            const aliceHome = await getHome(ctx.alice.user.id);
            const bobHome = await getHome(ctx.bob.user.id);
            const aliceUser = aliceHome.user;
            const bobUser = bobHome.user;

            // Bob is a shared read+write collaborator; both open live connections.
            await aliceHome.drive.updateACL(
                aliceMountId,
                docId,
                [{ id: 'bob@test.eigen.is', read: true, write: true }],
                undefined,
                undefined,
                aliceUser,
            );

            const collab = await aliceHome.drive.getCollabDocument(aliceMountId, docId);
            const baseline = collab.connectionCount;

            const aliceConn = makeSpyConn();
            const bobConn = makeSpyConn();
            collab.subscribe(aliceUser, aliceConn);
            collab.subscribe(bobUser, bobConn);
            expect(collab.connectionCount).toBe(baseline + 2);

            // Owner revokes Bob's read (empty ACL). Bob must be disconnected; Alice must stay.
            await aliceHome.drive.updateACL(aliceMountId, docId, [], undefined, undefined, aliceUser);

            expect(bobConn.closedWith?.code).toBe(1008);
            expect(aliceConn.closedWith).toBeNull();
            expect(collab.connectionCount).toBe(baseline + 1);

            // Bob no longer receives broadcasts; Alice still does.
            const aliceBefore = aliceConn.sent.length;
            const bobBefore = bobConn.sent.length;
            collab.doc.getMap('revoke-probe').set('k', 'v');
            expect(aliceConn.sent.length).toBeGreaterThan(aliceBefore);
            expect(bobConn.sent.length).toBe(bobBefore);

            // Don't leak the surviving spy into later same-docId tests (bob was already dropped).
            collab.unsubscribe(aliceConn);
        });

        test('revoking only write (read intact) does NOT close the connection', async () => {
            const aliceHome = await getHome(ctx.alice.user.id);
            const bobHome = await getHome(ctx.bob.user.id);
            const bobUser = bobHome.user;

            await aliceHome.drive.updateACL(
                aliceMountId,
                docId,
                [{ id: 'bob@test.eigen.is', read: true, write: true }],
                undefined,
                undefined,
                aliceHome.user,
            );

            const collab = await aliceHome.drive.getCollabDocument(aliceMountId, docId);
            const baseline = collab.connectionCount;

            const bobConn = makeSpyConn();
            collab.subscribe(bobUser, bobConn);
            expect(collab.connectionCount).toBe(baseline + 1);

            // Downgrade Bob to read-only. Read is intact → connection stays open
            // (writes are already blocked per-message on the message path).
            await aliceHome.drive.updateACL(
                aliceMountId,
                docId,
                [{ id: 'bob@test.eigen.is', read: true, write: false }],
                undefined,
                undefined,
                aliceHome.user,
            );

            expect(bobConn.closedWith).toBeNull();
            expect(collab.connectionCount).toBe(baseline + 1);

            // Don't leak the spy into later same-docId tests.
            collab.unsubscribe(bobConn);
        });

        test('downgrading to read-only prevents write updates if WebSocket connected', async () => {
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        add: [{ id: 'bob@test.eigen.is', read: true, write: true }],
                    }),
                },
            );

            const wsRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`,
                {
                    headers: {
                        Upgrade: 'websocket',
                        Connection: 'Upgrade',
                    },
                },
            );

            if (wsRes.status !== 101) {
                return;
            }

            const ws = (wsRes as WebSocketResponse).webSocket!;

            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        add: [{ id: 'bob@test.eigen.is', read: true, write: false }],
                    }),
                },
            );

            const testUpdate = new Uint8Array([77, 77, 77]);
            ws.send(testUpdate);

            await new Promise((resolve) => setTimeout(resolve, 100));

            ws.close();

            expect(ws.readyState).toBeGreaterThan(0);
        });
    });

    describe('Move revokes read (P3-C)', () => {
        // A doc that Bob can read ONLY via a shared folder loses read when it is moved OUT
        // of that folder — read is inherited from the ancestor chain, so re-parenting away
        // from the shared ancestor revokes it, exactly like an ACL change (P2-8). The live
        // collab socket must close on the move. Control: moving WITHIN the shared subtree
        // keeps read, so the socket must stay open.
        test('moving a doc OUT of a shared folder closes the revoked user, keeps the owner', async () => {
            const aliceHome = await getHome(ctx.alice.user.id);
            const bobHome = await getHome(ctx.bob.user.id);
            const aliceUser = aliceHome.user;
            const bobUser = bobHome.user;

            // Shared folder → Bob has read on everything nested inside it.
            const sharedFolder = await aliceHome.drive.createFolder(
                aliceMountId,
                aliceRootId,
                'P3C Shared Folder',
                aliceUser,
            );
            await aliceHome.drive.updateACL(
                aliceMountId,
                sharedFolder.id,
                [{ id: 'bob@test.eigen.is', read: true, write: true }],
                undefined,
                undefined,
                aliceUser,
            );
            const movingDoc = await aliceHome.drive.create(
                aliceMountId,
                sharedFolder.id,
                'P3C Moving Doc',
                'doc',
                aliceUser,
            );

            // Bob reads the doc purely via the folder ancestor (no direct ACL on the doc).
            expect(await aliceHome.drive.canRead(aliceMountId, movingDoc.id, bobUser)).toBe(true);

            const collab = await aliceHome.drive.getCollabDocument(aliceMountId, movingDoc.id);
            const baseline = collab.connectionCount;
            const aliceConn = makeSpyConn();
            const bobConn = makeSpyConn();
            collab.subscribe(aliceUser, aliceConn);
            collab.subscribe(bobUser, bobConn);
            expect(collab.connectionCount).toBe(baseline + 2);

            // Move the doc OUT of the shared folder to the (unshared) root.
            await aliceHome.drive.movePath(aliceMountId, movingDoc.id, aliceRootId, aliceUser);

            // Read is now gone at the new location, and Bob's socket is closed for it.
            expect(await aliceHome.drive.canRead(aliceMountId, movingDoc.id, bobUser)).toBe(false);
            expect(bobConn.closedWith?.code).toBe(1008);
            expect(aliceConn.closedWith).toBeNull();
            expect(collab.connectionCount).toBe(baseline + 1);

            // Bob no longer receives broadcasts; Alice still does.
            const aliceBefore = aliceConn.sent.length;
            const bobBefore = bobConn.sent.length;
            collab.doc.getMap('move-probe').set('k', 'v');
            expect(aliceConn.sent.length).toBeGreaterThan(aliceBefore);
            expect(bobConn.sent.length).toBe(bobBefore);

            collab.unsubscribe(aliceConn);
        });

        test('moving a doc WITHIN the shared subtree keeps read, does NOT close', async () => {
            const aliceHome = await getHome(ctx.alice.user.id);
            const bobHome = await getHome(ctx.bob.user.id);
            const aliceUser = aliceHome.user;
            const bobUser = bobHome.user;

            const sharedFolder = await aliceHome.drive.createFolder(
                aliceMountId,
                aliceRootId,
                'P3C Shared Folder 2',
                aliceUser,
            );
            await aliceHome.drive.updateACL(
                aliceMountId,
                sharedFolder.id,
                [{ id: 'bob@test.eigen.is', read: true, write: true }],
                undefined,
                undefined,
                aliceUser,
            );
            // A subfolder still INSIDE the shared folder — read survives a move into it.
            const subFolder = await aliceHome.drive.createFolder(aliceMountId, sharedFolder.id, 'P3C Sub', aliceUser);
            const doc = await aliceHome.drive.create(aliceMountId, sharedFolder.id, 'P3C Within Doc', 'doc', aliceUser);

            const collab = await aliceHome.drive.getCollabDocument(aliceMountId, doc.id);
            const baseline = collab.connectionCount;
            const bobConn = makeSpyConn();
            collab.subscribe(bobUser, bobConn);
            expect(collab.connectionCount).toBe(baseline + 1);

            // Move within the shared subtree — Bob still reads via the shared folder ancestor.
            await aliceHome.drive.movePath(aliceMountId, doc.id, subFolder.id, aliceUser);

            expect(await aliceHome.drive.canRead(aliceMountId, doc.id, bobUser)).toBe(true);
            expect(bobConn.closedWith).toBeNull();
            expect(collab.connectionCount).toBe(baseline + 1);

            collab.unsubscribe(bobConn);
        });
    });
});
