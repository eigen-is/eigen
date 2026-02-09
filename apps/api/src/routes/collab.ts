import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {type ServerWebSocket} from "bun";
import {getSharedDrive} from "../lib/drive/sharedDrive.ts";
import {keepWebSocketAlive} from "../utils/websockets.ts";

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

    // WebSocket endpoint for collaborative editing
    .ws("/ws/collab/:ownerId/:mountId/:pathId", {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            mountId: t.String(),
            pathId: t.String(),
        }),

        async open(ws) {
            console.log('WebSocket connection opened');

            // @ts-ignore
            const user = ws.data?.user;
            if (!user) {
                ws.close(1008, "Authentication failed");
                return;
            }

            const ownerId = ws.data.params.ownerId;
            const mountId = ws.data.params.mountId;
            const pathId = ws.data.params.pathId;

            const drive = await getSharedDrive(ownerId, user);
            if (!drive || !(await drive.canRead(mountId, pathId, user))) {
                ws.close(1008, "Authentication failed");
                return;
            }
            try {
                const document = await drive.getCollabDocument(mountId, pathId);

                document.subscribe(user, ws as unknown as ServerWebSocket<any>);

                keepWebSocketAlive(user, ws as unknown as ServerWebSocket<any>, async () => {
                    try {
                        document.unsubscribe(user, ws as unknown as ServerWebSocket<any>);
                    } catch (err) {
                        console.error('Error unsubscribing from document:', err);
                    }
                });
            } catch (err) {
                console.error('Error getting document:', err);
                ws.close(1008, "Failed to get document");
            }
        },

        async message(ws, message) {
            // @ts-ignore
            const user = ws.data?.user;
            if (!user) {
                ws.close(1008, "Authentication failed");
                return;
            }

            const ownerId = ws.data.params.ownerId;
            const mountId = ws.data.params.mountId;
            const pathId = ws.data.params.pathId;

            if (typeof message === 'string') {
                if (message === 'ping') {
                    ws.send('pong');
                }
                return;
            }

            try {
                const update = message instanceof Uint8Array ? message : new Uint8Array(message as Buffer);

                const drive = await getSharedDrive(ownerId, user);
                if (!drive || !(await drive.canRead(mountId, pathId, user))) {
                    console.error('canRead failed');
                    ws.close(1008, "Authentication failed");
                    return;
                }
                const document = await drive.getCollabDocument(mountId, pathId);
                document.handleMessage(ws as unknown as ServerWebSocket<any>, update, await drive.canWrite(mountId, pathId, user));
            } catch (err) {
                console.error('Error processing message:', err);
            }
        },

        async close(ws) {
            try {
                // @ts-ignore
                const user = ws.data?.user;
                if (!user) {
                    ws.close(1008, "Authentication failed");
                    return;
                }

                const ownerId = ws.data.params.ownerId;
                const mountId = ws.data.params.mountId;
                const pathId = ws.data.params.pathId;

                try {
                    const drive = await getSharedDrive(ownerId, user);
                    const document = await drive.getCollabDocument(mountId, pathId);
                    document.unsubscribe(user, ws as unknown as ServerWebSocket<any>);
                } catch (err) {
                    console.error('Error handling WebSocket close:', err);
                }
            } catch (err) {
                console.error('Error handling WebSocket close:', err);
            }
        }
    });
