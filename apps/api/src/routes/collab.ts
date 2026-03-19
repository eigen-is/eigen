import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {type ServerWebSocket} from "bun";
import {getSharedDrive} from "../lib/drive";
import {keepWebSocketAlive} from "../utils/websockets.ts";

// Collab routes allow cross-owner access (collaborative editing on shared/team drives).
// Access control is enforced by getSharedDrive() → SharedDrive ACL checks.
export const collabRouter = new Elysia({
    name: "collab",
    websocket: {
        perMessageDeflate: true,
    }
})
    .use(betterAuth)

    .get("/collab/:ownerId/:mountId/:pathId/info", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const canRead = await drive.canRead(params.mountId, params.pathId, user);
        const canWrite = await drive.canWrite(params.mountId, params.pathId, user);

        if (!canRead) {
            return {canRead, canWrite, path: null, folderContents: null};
        }

        const path = await drive.getPath(params.mountId, params.pathId);
        const folderContents = await drive.getFolderContents(params.mountId, params.pathId);

        return {canRead, canWrite, path, folderContents};
    }, {auth: true})

    .get("/collab/:ownerId/:mountId/:pathId/revisions", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        if (!await drive.canRead(params.mountId, params.pathId, user)) {
            return {revisions: []};
        }
        const document = await drive.getCollabDocument(params.mountId, params.pathId);
        return {revisions: document.getRevisions()};
    }, {auth: true})

    .get("/collab/:ownerId/:mountId/:pathId/revisions/:revisionId", async ({params, user, set}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        if (!await drive.canRead(params.mountId, params.pathId, user)) {
            set.status = 403;
            return {error: "No read permission"};
        }
        const document = await drive.getCollabDocument(params.mountId, params.pathId);
        const state = document.getRevisionState(parseInt(params.revisionId, 10));
        if (!state) {
            set.status = 404;
            return {error: "Revision not found"};
        }
        return new Response(Buffer.from(state), {
            headers: {"Content-Type": "application/octet-stream"}
        });
    }, {auth: true})

    // WebSocket endpoint for collaborative editing
    .ws("/ws/collab/:ownerId/:mountId/:pathId", {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            mountId: t.String(),
            pathId: t.String(),
        }),

        async open(ws) {
            // @ts-ignore
            const user = ws.data?.user;
            if (!user) {
                ws.close(1008, "Authentication failed");
                return;
            }

            const {ownerId, mountId, pathId} = ws.data.params;

            const drive = await getSharedDrive(ownerId, user);
            if (!drive || !(await drive.canRead(mountId, pathId, user))) {
                ws.close(1008, "Authentication failed");
                return;
            }
            try {
                const document = await drive.getCollabDocument(mountId, pathId);
                const rawWs = ws as unknown as ServerWebSocket<any>;
                document.subscribe(user, rawWs);

                // @ts-ignore – store on ws.data for use in message/close handlers
                ws.data.collabDocument = document;
                // @ts-ignore
                ws.data.collabCleaned = false;

                const cleanup = () => {
                    // @ts-ignore
                    if (ws.data.collabCleaned) return;
                    // @ts-ignore
                    ws.data.collabCleaned = true;
                    try {
                        document.unsubscribe(user, rawWs);
                    } catch (err) {
                        console.error('Error unsubscribing from document:', err);
                    }
                };

                keepWebSocketAlive(user, rawWs, cleanup);
            } catch (err) {
                console.error('Error getting document:', err);
                ws.close(1008, "Failed to get document");
            }
        },

        async message(ws, message) {
            if (typeof message === 'string') {
                if (message === 'ping') ws.send('pong');
                return;
            }

            // @ts-ignore
            const user = ws.data?.user;
            if (!user) {
                ws.close(1008, "Authentication failed");
                return;
            }

            try {
                const update = message instanceof Uint8Array ? message : new Uint8Array(message as Buffer);
                const {ownerId, mountId, pathId} = ws.data.params;

                // @ts-ignore – set by open handler; may be absent if message arrives before open completes
                let document = ws.data.collabDocument;
                if (!document) {
                    const drive = await getSharedDrive(ownerId, user);
                    if (!drive || !(await drive.canRead(mountId, pathId, user))) return;
                    document = await drive.getCollabDocument(mountId, pathId);
                    // @ts-ignore
                    ws.data.collabDocument = document;
                }

                const drive = await getSharedDrive(ownerId, user);
                const canWrite = await drive.canWrite(mountId, pathId, user);
                document.handleMessage(ws as unknown as ServerWebSocket<any>, update, canWrite);
            } catch (err) {
                console.error('Error processing message:', err);
            }
        },

        close(ws) {
            // @ts-ignore
            if (ws.data?.collabCleaned) return;
            // @ts-ignore
            ws.data.collabCleaned = true;

            // @ts-ignore
            const user = ws.data?.user;
            // @ts-ignore
            const document = ws.data?.collabDocument;
            if (user && document) {
                try {
                    document.unsubscribe(user, ws as unknown as ServerWebSocket<any>);
                } catch (err) {
                    console.error('Error unsubscribing from document:', err);
                }
            }
        }
    });
