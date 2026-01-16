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

    .get("/collab/access/:ownerId/:pathId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const canRead = await drive.canRead(params.pathId, user);
        const canWrite = await drive.canWrite(params.pathId, user);
        return {canRead, canWrite};
    }, {auth: true})

    // WebSocket endpoint for collaborative editing
    .ws("/ws/collab/:ownerId/:pathId", {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            pathId: t.String(),
        }),

        async open(ws) {
            console.log('WebSocket connection opened');

            // Get user from ws.data (provided by betterAuth)
            // @ts-ignore
            const user = ws.data?.user;
            if (!user) {
                ws.close(1008, "Authentication failed");
                return;
            }

            const ownerId = ws.data.params.ownerId;
            const pathId = ws.data.params.pathId;

            const drive = await getSharedDrive(ownerId, user);
            if (!drive || !(await drive.canRead(pathId, user))) {
                ws.close(1008, "Authentication failed");
                return;
            }
            try {
            const document = await drive.getCollabDocument(pathId);

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
                if (!drive || !(await drive.canRead(pathId, user))) {
                    console.error('canRead failed');
                    ws.close(1008, "Authentication failed");
                    return;
                }
                const document = await drive.getCollabDocument(pathId);
                document.handleMessage(ws as unknown as ServerWebSocket<any>, update, await drive.canWrite(pathId, user));
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
                const pathId = ws.data.params.pathId;

                try {
                    const drive = await getSharedDrive(ownerId, user);
                    const document = await drive.getCollabDocument(pathId);
                    document.unsubscribe(user, ws as unknown as ServerWebSocket<any>);
                } catch (err) {
                    console.error('Error handling WebSocket close:', err);
                }
            } catch (err) {
                console.error('Error handling WebSocket close:', err);
            }
        }
    });
