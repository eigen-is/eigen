import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {type ServerWebSocket} from "bun";
import {getSharedDrive} from "../lib/drive";
import {keepWebSocketAlive} from "../utils/websockets.ts";
import {ApiError} from "../lib/core/errors.ts";
import type CollabDocument from "../lib/collab/collabDocument.ts";
import type {User} from "better-auth/types";
import type Drive from "../lib/drive/drive.ts";
import type SharedDrive from "../lib/drive/sharedDrive.ts";

type CollabWsData = {
    user?: User;
    params: { ownerId: string; mountId: string; pathId: string };
    drive?: Drive | SharedDrive;
    collabDocument?: CollabDocument;
    collabCleaned?: boolean;
    pingInterval?: ReturnType<typeof setInterval>;
};

// Collab routes allow cross-owner access (collaborative editing on shared/team drives).
// Access control is enforced by getSharedDrive() → SharedDrive ACL checks.
export const collabRouter = new Elysia({
    name: "collab",
    websocket: {
        perMessageDeflate: true,
        maxPayloadLength: 4 * 1024 * 1024, // 4 MB
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
            throw new ApiError(403, "No read permission");
        }
        const document = await drive.getCollabDocument(params.mountId, params.pathId);
        return {revisions: document.getRevisions()};
    }, {auth: true})

    .get("/collab/:ownerId/:mountId/:pathId/revisions/:revisionId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        if (!await drive.canRead(params.mountId, params.pathId, user)) {
            throw new ApiError(403, "No read permission");
        }
        const document = await drive.getCollabDocument(params.mountId, params.pathId);
        const revisionId = Number(params.revisionId);
        if (!Number.isInteger(revisionId) || revisionId <= 0) {
            throw new ApiError(400, "Invalid revision ID");
        }
        const state = document.getRevisionState(revisionId);
        if (!state) {
            throw new ApiError(404, "Revision not found");
        }
        return new Response(Buffer.from(state), {
            headers: {"Content-Type": "application/octet-stream"}
        });
    }, {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            mountId: t.String(),
            pathId: t.String(),
            revisionId: t.String({pattern: '^[0-9]+$'}),
        }),
    })

    // WebSocket endpoint for collaborative editing
    .ws("/ws/collab/:ownerId/:mountId/:pathId", {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            mountId: t.String(),
            pathId: t.String(),
        }),

        async open(ws) {
            const data = ws.data as unknown as CollabWsData;
            const user = data.user;
            if (!user) {
                ws.close(1008, "Authentication failed");
                return;
            }

            const {ownerId, mountId, pathId} = data.params;

            const drive = await getSharedDrive(ownerId, user);
            if (!drive || !(await drive.canRead(mountId, pathId, user))) {
                ws.close(1008, "Authentication failed");
                return;
            }

            try {
                const document = await drive.getCollabDocument(mountId, pathId);
                const rawWs = ws as unknown as ServerWebSocket<any>;
                document.subscribe(user, rawWs);

                data.drive = drive;
                data.collabDocument = document;
                data.collabCleaned = false;

                const cleanup = () => {
                    if (data.collabCleaned) return;
                    data.collabCleaned = true;
                    if (data.pingInterval) clearInterval(data.pingInterval);
                    try {
                        document.unsubscribe(user, rawWs);
                    } catch (err) {
                        console.error('Error unsubscribing from document:', err);
                    }
                };

                data.pingInterval = keepWebSocketAlive(user, rawWs, cleanup);
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

            const data = ws.data as unknown as CollabWsData;
            const user = data.user;
            if (!user) {
                ws.close(1008, "Authentication failed");
                return;
            }

            try {
                const update = message instanceof Uint8Array ? message : new Uint8Array(message as Buffer);
                const {mountId, pathId} = data.params;

                // drive is cached at open; fallback to fresh lookup if message arrives before open completes
                const drive = data.drive ?? await getSharedDrive(data.params.ownerId, user);
                let document = data.collabDocument;
                if (!document) {
                    if (!(await drive.canRead(mountId, pathId, user))) return;
                    document = await drive.getCollabDocument(mountId, pathId);
                    data.collabDocument = document;
                }

                const canWrite = await drive.canWrite(mountId, pathId, user);
                document.handleMessage(ws as unknown as ServerWebSocket<any>, update, canWrite);
            } catch (err) {
                console.error('Error processing message:', err);
            }
        },

        close(ws) {
            const data = ws.data as unknown as CollabWsData;
            if (data.collabCleaned) return;
            data.collabCleaned = true;

            if (data.pingInterval) clearInterval(data.pingInterval);

            const user = data.user;
            const document = data.collabDocument;
            if (user && document) {
                try {
                    document.unsubscribe(user, ws as unknown as ServerWebSocket<any>);
                } catch (err) {
                    console.error('Error unsubscribing from document:', err);
                }
            }
        }
    });
