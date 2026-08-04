import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import { type EffectiveMember, stripEigenExtension } from '@workspace/lib/types/drive';
import type { ServerWebSocket } from 'bun';
import { Elysia, t } from 'elysia';
import { getCommentIndex } from '../lib/chat/comment-index';
import { broadcastCommentIndexUpdated } from '../lib/chat/sse-events';
import type CollabDocument from '../lib/collab/collabDocument';
import { startLoadingHeartbeat } from '../lib/collab/loading-heartbeat';
import { ApiError } from '../lib/core/errors';
import { getSharedDrive } from '../lib/drive';
import type Drive from '../lib/drive/drive';
import type SharedDrive from '../lib/drive/sharedDrive';
import { touchHomeIfLoaded } from '../lib/home';
import { sendToHome } from '../lib/home/home-relay';
import { getUserByEmail, type User } from '../lib/user';
import { keepWebSocketAlive } from '../utils/websockets';
import { betterAuth } from './auth';

// Elysia allocates a fresh ElysiaWS per WS event; only its stable `.raw` socket keeps one identity across open/message/close, so the Yjs origin matches the subscribed connection.
const toRawWs = (ws: unknown) => (ws as { raw: ServerWebSocket<undefined> }).raw;

type CollabWsData = {
    user?: User;
    params: { ownerId: string; mountId: string; pathId: string };
    drive?: Drive | SharedDrive;
    collabDocument?: CollabDocument;
    pingInterval?: ReturnType<typeof setInterval>;
    opened?: Promise<void>;
};

function cleanupSession(data: CollabWsData, ws: ServerWebSocket<undefined>) {
    if (data.pingInterval) clearInterval(data.pingInterval);
    data.pingInterval = undefined;
    if (data.user && data.collabDocument) {
        try {
            data.collabDocument.unsubscribe(data.user, ws);
        } catch (err) {
            console.error('Error unsubscribing from document:', err);
        }
    }
    data.collabDocument = undefined;
}

// Collab routes allow cross-owner access (collaborative editing on shared/team drives).
// Access control is enforced by getSharedDrive() → SharedDrive ACL checks.
// WebSocket server options (perMessageDeflate, maxPayloadLength) can't live here —
// Elysia only honors `websocket` config on the root app instance, so it's set in
// app.ts. (The block previously here was a silent no-op.)
export const collabRouter = new Elysia({
    name: 'collab',
})
    .use(betterAuth)

    .get(
        '/collab/:ownerId/:mountId/:pathId/info',
        async ({ params, user }): Promise<CollabDocumentInfo> => {
            const drive = await getSharedDrive(params.ownerId, user);
            const canRead = await drive.canRead(params.mountId, params.pathId, user);
            const canWrite = await drive.canWrite(params.mountId, params.pathId, user);

            if (!canRead) {
                return { canRead, canWrite, path: null, folderContents: null };
            }

            const path = await drive.getPath(params.mountId, params.pathId);
            const folderContents = await drive.getFolderContents(params.mountId, params.pathId);

            return { canRead, canWrite, path, folderContents };
        },
        { auth: true },
    )

    .get(
        '/collab/:ownerId/:mountId/:pathId/comments',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const index = await getCommentIndex(drive, params.mountId, params.pathId);
            return await index.list();
        },
        { auth: true },
    )

    .get(
        '/collab/:ownerId/:mountId/:pathId/comments/search',
        async ({ params, query, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const index = await getCommentIndex(drive, params.mountId, params.pathId);
            return await index.searchComments(query.q);
        },
        {
            auth: true,
            query: t.Object({ q: t.String({ minLength: 1, maxLength: 256 }) }),
        },
    )

    .patch(
        '/collab/:ownerId/:mountId/:pathId/comments/:chatName/status',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            if (!(await drive.canWrite(params.mountId, params.pathId, user))) {
                throw new ApiError(403, 'No write permission');
            }
            await drive.setCommentStatus(params.mountId, params.pathId, params.chatName, body.status, user, body.title);
            broadcastCommentIndexUpdated(drive, params.ownerId, params.mountId, params.pathId).catch(() => {});
            return { success: true };
        },
        {
            body: t.Object({
                status: t.Union([t.Literal('resolved'), t.Literal('open')]),
                title: t.Optional(t.String()),
            }),
            auth: true,
        },
    )

    .patch(
        '/collab/:ownerId/:mountId/:pathId/comments/:chatName/assignee',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            if (!(await drive.canWrite(params.mountId, params.pathId, user))) {
                throw new ApiError(403, 'No write permission');
            }
            const assignee = body.assignee ? body.assignee.toLowerCase() : null;
            // Resolved once for validation, reused by the broadcast fan-out (it's a full ACL walk).
            let members: EffectiveMember[] | undefined;
            if (assignee) {
                members = await drive.getEffectiveMembers(params.mountId, params.pathId);
                if (!members.some((m) => m.email === assignee)) {
                    throw new ApiError(400, 'Assignee is not a member of this document');
                }
            }
            const changed = await drive.assignComment(
                params.mountId,
                params.pathId,
                params.chatName,
                assignee,
                user,
                body.title,
            );

            broadcastCommentIndexUpdated(drive, params.ownerId, params.mountId, params.pathId, members).catch(() => {});

            if (changed && assignee && assignee !== user.email.toLowerCase()) {
                try {
                    const assigneeUser = await getUserByEmail(assignee);
                    const path = assigneeUser ? await drive.getPath(params.mountId, params.pathId) : null;
                    if (assigneeUser && path) {
                        await sendToHome(assigneeUser.id, {
                            type: 'notification',
                            notification: {
                                type: 'assigned',
                                actorEmail: user.email,
                                title: `${user.name} assigned you a comment on "${stripEigenExtension(path.name)}"`,
                                tag: `assigned:${params.ownerId}:${params.mountId}:${params.pathId}:${params.chatName}`,
                                details: { pathType: path.type },
                            },
                        });
                    }
                } catch {
                    // user or home may not exist (unregistered guests get no notification)
                }
            }
            return { success: true };
        },
        {
            body: t.Object({ assignee: t.Nullable(t.String()), title: t.Optional(t.String()) }),
            auth: true,
        },
    )

    // Bun does not await async open(), so messages and close can fire before setup
    // completes. The `opened` promise gates message/close until open() is done.
    .ws('/ws/collab/:ownerId/:mountId/:pathId', {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            mountId: t.String(),
            pathId: t.String(),
        }),

        async open(ws) {
            const data = ws.data as unknown as CollabWsData;
            let resolve: () => void;
            data.opened = new Promise((r) => {
                resolve = r;
            });

            let stopHeartbeat: (() => void) | undefined;
            try {
                const user = data.user;
                if (!user) {
                    ws.close(1008, 'Authentication failed');
                    return;
                }

                // Speak before any await: y-websocket closes after 30s of silence and
                // retries, re-paying a cold open per attempt (the reconnect spiral).
                // Cold Home init inside getSharedDrive is the slowest phase, so the
                // heartbeat must precede it; the frame is a constant empty awareness
                // update, so nothing leaks before the ACL check.
                const rawWs = toRawWs(ws);
                stopHeartbeat = startLoadingHeartbeat(rawWs);
                const loadStart = performance.now();

                const { ownerId, mountId, pathId } = data.params;
                const drive = await getSharedDrive(ownerId, user);
                if (!drive || !(await drive.canRead(mountId, pathId, user))) {
                    ws.close(1008, 'Authentication failed');
                    return;
                }

                const document = await drive.getCollabDocument(mountId, pathId);
                document.subscribe(user, rawWs);
                console.log(
                    `[collab] open path=${pathId} loadMs=${(performance.now() - loadStart).toFixed(0)} ` +
                        `connections=${document.connectionCount}`,
                );

                data.drive = drive;
                data.collabDocument = document;
                // Pin the doc-owner's home on every keepalive tick, mirroring how SSE pins a user's own home.
                data.pingInterval = keepWebSocketAlive(
                    user,
                    rawWs,
                    () => cleanupSession(data, rawWs),
                    () => touchHomeIfLoaded(ownerId),
                );
            } catch (err) {
                console.error('Error opening collab session:', err);
                ws.close(1008, 'Failed to open document');
            } finally {
                stopHeartbeat?.();
                resolve!();
            }
        },

        async message(ws, message) {
            if (typeof message === 'string') {
                if (message === 'ping') ws.send('pong');
                return;
            }

            const data = ws.data as unknown as CollabWsData;
            if (data.opened) await data.opened;

            const { user, drive, collabDocument } = data;
            if (!user || !drive || !collabDocument) return;

            try {
                const update = message instanceof Uint8Array ? message : new Uint8Array(message as Buffer);
                const { mountId, pathId } = data.params;
                const canWrite = await drive.canWrite(mountId, pathId, user);
                collabDocument.handleMessage(toRawWs(ws), update, canWrite);
            } catch (err) {
                console.error('Error processing collab message:', err);
            }
        },

        async close(ws, code) {
            const data = ws.data as unknown as CollabWsData;
            if (data.opened) await data.opened;
            const remaining = data.collabDocument ? data.collabDocument.connectionCount - 1 : null;
            cleanupSession(data, toRawWs(ws));
            if (remaining !== null) {
                console.log(`[collab] close path=${data.params.pathId} code=${code} connections=${remaining}`);
            }
        },
    });
