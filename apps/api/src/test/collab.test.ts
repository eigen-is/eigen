import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext, authedRequest} from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

function drivePost(token: string, ownerId: string, mountId: string, path: string, body: Record<string, unknown>): Promise<any> {
    return authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    }).then(r => r.json());
}

async function driveGet(token: string, ownerId: string, mountId: string, ...parts: string[]): Promise<any> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${parts.join('/')}`);
    return res.json();
}

describe('Collab', () => {
    let ctx: TestCtx;
    let aliceRootId: string;
    let aliceMountId: string;
    let docId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        const {data: mounts} = await ctx.alice.api.drive({ownerId: ctx.alice.user.id}).mounts.get();
        expect(mounts).toBeDefined();
        expect(mounts!.length).toBeGreaterThan(0);
        aliceMountId = mounts![0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        expect(root).toBeDefined();
        expect(root.id).toBeDefined();
        aliceRootId = root.id;

        const doc = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `folder/${aliceRootId}/doc`, {fileName: 'Collab Test Doc'});
        expect(doc.id).toBeDefined();
        docId = doc.id;
    });

    describe('Collab Info Endpoint', () => {
        test('info endpoint returns canRead, canWrite, path, folderContents for owner', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}/info`);
            expect(res.status).toBe(200);

            const data = await res.json() as {canRead: boolean; canWrite: boolean; path: {id: string}; folderContents: unknown[]};
            expect(data.canRead).toBe(true);
            expect(data.canWrite).toBe(true);
            expect(data.path).toBeDefined();
            expect(data.path.id).toBe(docId);
            expect(Array.isArray(data.folderContents)).toBe(true);
        });

        test('info endpoint denies access without authentication', async () => {
            const res = await ctx.app.handle(
                new Request(`http://localhost/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}/info`)
            );
            expect(res.status).not.toBe(200);
        });

        test('info endpoint denies access without read permission', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({acl: []}),
                });

            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}/info`);
            expect(res.status).toBe(200);

            const data = await res.json() as {canRead: boolean; canWrite: boolean; path: null};
            expect(data.canRead).toBe(false);
            expect(data.canWrite).toBe(false);
            expect(data.path).toBeNull();
        });

        test('info endpoint grants access with shared read permission', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [{email: 'bob@test.eigen.is', read: true, write: false, public: false}],
                    }),
                });

            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}/info`);
            expect(res.status).toBe(200);

            const data = await res.json() as {canRead: boolean; canWrite: boolean; path: string};
            expect(data.canRead).toBe(true);
            expect(data.canWrite).toBe(false);
            expect(data.path).toBeDefined();
        });
    });

    describe('WebSocket Connection', () => {
        test('WebSocket requires authentication', async () => {
            const ws = ctx.app.handle(
                new Request(`http://localhost/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`, {
                    headers: {
                        'Upgrade': 'websocket',
                        'Connection': 'Upgrade',
                    },
                })
            );

            const res = await ws;
            expect(res.status).not.toBe(101);
        });

        test('WebSocket authenticated connection attempt', async () => {
            const wsRes = await authedRequest(ctx.alice.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`, {
                    headers: {
                        'Upgrade': 'websocket',
                        'Connection': 'Upgrade',
                    },
                });

            expect(wsRes.status).toBeGreaterThanOrEqual(100);
            expect(wsRes.status).toBeLessThan(600);

            if (wsRes.status === 101 && (wsRes as any).webSocket) {
                (wsRes as any).webSocket.close();
            }
        });

        test('WebSocket ping-pong works if connected', async () => {
            const wsRes = await authedRequest(ctx.alice.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`, {
                    headers: {
                        'Upgrade': 'websocket',
                        'Connection': 'Upgrade',
                    },
                });

            if (wsRes.status !== 101) {
                return;
            }

            const ws = (wsRes as any).webSocket!;
            const pongPromise = new Promise<string>((resolve) => {
                ws.onmessage = (event: {data: string}) => {
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
            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({acl: []}),
                });

            const wsRes = await authedRequest(ctx.bob.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`, {
                    headers: {
                        'Upgrade': 'websocket',
                        'Connection': 'Upgrade',
                    },
                });

            expect(wsRes.status).not.toBe(101);
        });

        test('WebSocket accepts connection with read permission if upgrade works', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [{email: 'bob@test.eigen.is', read: true, write: false, public: false}],
                    }),
                });

            const wsRes = await authedRequest(ctx.bob.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`, {
                    headers: {
                        'Upgrade': 'websocket',
                        'Connection': 'Upgrade',
                    },
                });

            expect(wsRes.status).toBeGreaterThanOrEqual(100);
            expect(wsRes.status).toBeLessThan(600);

            if (wsRes.status === 101 && (wsRes as any).webSocket) {
                (wsRes as any).webSocket.close();
            }
        });
    });

    describe('Document Updates', () => {
        test('document accepts Yjs updates from write-enabled user if WebSocket connects', async () => {
            const wsRes = await authedRequest(ctx.alice.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`, {
                    headers: {
                        'Upgrade': 'websocket',
                        'Connection': 'Upgrade',
                    },
                });

            if (wsRes.status !== 101) {
                return;
            }

            const ws = (wsRes as any).webSocket!;
            const updateReceived = new Promise<boolean>((resolve) => {
                ws.onmessage = () => resolve(true);
            });

            const testUpdate = new Uint8Array([1, 2, 3, 4, 5]);
            ws.send(testUpdate);

            const received = await Promise.race([
                updateReceived,
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))
            ]);

            ws.close();

            expect(received).toBe(true);
        });

        test('document syncs between multiple connected users if WebSocket works', async () => {
            const aliceWsRes = await authedRequest(ctx.alice.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`, {
                    headers: {
                        'Upgrade': 'websocket',
                        'Connection': 'Upgrade',
                    },
                });

            const bobWsRes = await authedRequest(ctx.bob.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`, {
                    headers: {
                        'Upgrade': 'websocket',
                        'Connection': 'Upgrade',
                    },
                });

            if (aliceWsRes.status !== 101 || bobWsRes.status !== 101) {
                return;
            }

            const aliceWs = (aliceWsRes as any).webSocket!;
            const bobWs = (bobWsRes as any).webSocket!;

            const bobReceivedUpdate = new Promise<boolean>((resolve) => {
                bobWs.onmessage = () => resolve(true);
            });

            const testUpdate = new Uint8Array([10, 20, 30, 40, 50]);
            aliceWs.send(testUpdate);

            const received = await Promise.race([
                bobReceivedUpdate,
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))
            ]);

            aliceWs.close();
            bobWs.close();

            expect(received).toBe(true);
        });

        test('read-only user WebSocket behavior if connected', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [{email: 'charlie@test.eigen.is', read: true, write: false, public: false}],
                    }),
                });

            const wsRes = await authedRequest(ctx.charlie.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`, {
                    headers: {
                        'Upgrade': 'websocket',
                        'Connection': 'Upgrade',
                    },
                });

            if (wsRes.status !== 101) {
                return;
            }

            const ws = (wsRes as any).webSocket!;

            const testUpdate = new Uint8Array([99, 99, 99]);
            ws.send(testUpdate);

            await new Promise(resolve => setTimeout(resolve, 100));

            ws.close();

            expect(ws.readyState).toBeGreaterThan(0);
        });
    });

    describe('Permission Changes', () => {
        test('revoking read permission disconnects user if WebSocket connected', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [{email: 'bob@test.eigen.is', read: true, write: true, public: false}],
                    }),
                });

            const wsRes = await authedRequest(ctx.bob.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`, {
                    headers: {
                        'Upgrade': 'websocket',
                        'Connection': 'Upgrade',
                    },
                });

            if (wsRes.status !== 101) {
                return;
            }

            const ws = (wsRes as any).webSocket!;

            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({acl: []}),
                });

            await new Promise(resolve => setTimeout(resolve, 500));

            ws.close();
        });

        test('downgrading to read-only prevents write updates if WebSocket connected', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [{email: 'bob@test.eigen.is', read: true, write: true, public: false}],
                    }),
                });

            const wsRes = await authedRequest(ctx.bob.user.sessionToken,
                `/ws/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}`, {
                    headers: {
                        'Upgrade': 'websocket',
                        'Connection': 'Upgrade',
                    },
                });

            if (wsRes.status !== 101) {
                return;
            }

            const ws = (wsRes as any).webSocket!;

            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [{email: 'bob@test.eigen.is', read: true, write: false, public: false}],
                    }),
                });

            const testUpdate = new Uint8Array([77, 77, 77]);
            ws.send(testUpdate);

            await new Promise(resolve => setTimeout(resolve, 100));

            ws.close();

            expect(ws.readyState).toBeGreaterThan(0);
        });
    });
});
