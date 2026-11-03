// The collab routes: a document's access info and comment index over HTTP, and the WebSocket each
// editor opens to sync a document. The socket checks read once when it opens and write on every
// message, and it hands the frames to the CollabDocument the Drive keeps open for that document.

import {
    COLLAB_HOME_REPLACED_CLOSE,
    COLLAB_HOME_REPLACED_REASON,
    COLLAB_STORAGE_GONE_CLOSE,
    COLLAB_STORAGE_GONE_REASON,
    COLLAB_STORAGE_UNAVAILABLE_CLOSE,
    COLLAB_STORAGE_UNAVAILABLE_REASON,
} from '@workspace/lib/constants/collab';
import { commentAssignedTag } from '@workspace/lib/notification/tags';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { Elysia, t } from 'elysia';
import type { ServerWebSocket } from 'elysia/ws/bun';
import { withCommentIndex } from '../lib/chat';
import { broadcastCommentIndexUpdated } from '../lib/chat/sse-events';
import type { CollabDocument } from '../lib/collab/collab-document';
import { collabEpochMessage } from '../lib/collab/epoch';
import { startLoadingHeartbeat } from '../lib/collab/loading-heartbeat';
import { ApiError } from '../lib/core/errors';
import { getSharedDrive } from '../lib/drive';
import type { DriveLike } from '../lib/drive/get-drive';
import { getDataEpoch } from '../lib/home/data-epoch';
import { sendToHome } from '../lib/home/home-relay';
import { getUserByEmail } from '../lib/user';
import { keepWebSocketAlive } from '../utils/websockets';
import { betterAuth } from './auth';

type CollabSession = {
    opened: Promise<void>;
    drive?: DriveLike;
    collabDocument?: CollabDocument;
    pingInterval?: ReturnType<typeof setInterval>;
    releaseHome?: () => void;
};

// Elysia hands each socket event a new wrapper. Only the raw socket under it stays the same from open to
// close, and it has no typed field for this route's state, so the state lives in this map.
const sessions = new WeakMap<ServerWebSocket<unknown>, CollabSession>();

// A user may open a document in another owner's drive, such as a shared or team drive. getSharedDrive and its ACL
// checks decide what they may do there. The WebSocket server options, such as perMessageDeflate, are set on the root
// app, because Elysia reads `websocket` config only there.
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
            return withCommentIndex(drive, params.mountId, params.pathId, (index) => index.list());
        },
        { auth: true },
    )

    .get(
        '/collab/:ownerId/:mountId/:pathId/comments/search',
        async ({ params, query, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return withCommentIndex(drive, params.mountId, params.pathId, (index) => index.searchComments(query.q));
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
            // Looked up once for the check and passed on to the broadcast, because it walks the whole ACL.
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
                                tag: commentAssignedTag({
                                    ownerId: params.ownerId,
                                    mountId: params.mountId,
                                    pathId: params.pathId,
                                    chatName: params.chatName,
                                }),
                                details: { pathType: path.type },
                            },
                        });
                    }
                } catch {
                    // The user or their home may not exist: an unregistered guest gets no notification.
                }
            }
            return { success: true };
        },
        {
            body: t.Object({ assignee: t.Nullable(t.String()), title: t.Optional(t.String()) }),
            auth: true,
        },
    )

    // Bun does not await an async open, so a message or the close can arrive before the setup is done.
    // They wait for the `opened` promise first.
    .ws('/ws/collab/:ownerId/:mountId/:pathId', {
        auth: true,
        params: t.Object({
            ownerId: t.String(),
            mountId: t.String(),
            pathId: t.String(),
        }),
        query: t.Object({ epoch: t.Optional(t.String()) }),

        async open(ws) {
            const { promise, resolve } = Promise.withResolvers<void>();
            const session: CollabSession = { opened: promise };
            sessions.set(ws.raw, session);

            let stopHeartbeat: (() => void) | undefined;
            try {
                const user = ws.data.user;

                // y-websocket closes a socket that stays silent for 30 seconds and retries, and every retry
                // pays for a cold open again. Opening a cold Home in getSharedDrive is the slowest step, so the
                // heartbeat starts before it. Its frame is a constant empty awareness update, so it reveals
                // nothing before the access check.
                const rawWs = ws.raw;
                stopHeartbeat = startLoadingHeartbeat(rawWs);
                const loadStart = performance.now();

                const { ownerId, mountId, pathId } = ws.data.params;
                // A stale epoch means the tab loaded its document before a restore or an update. Its sync would
                // bring back what the restore undid, or write structures the new code no longer reads.
                const { epoch } = ws.data.query;
                if (epoch !== undefined && epoch !== getDataEpoch(ownerId)) {
                    ws.close(COLLAB_HOME_REPLACED_CLOSE, COLLAB_HOME_REPLACED_REASON);
                    return;
                }
                const drive = await getSharedDrive(ownerId, user);
                if (!(await drive.canRead(mountId, pathId, user))) {
                    ws.close(1008, 'Access denied');
                    return;
                }
                // Only a user who may read holds the Home. The hold keeps it open until cleanupSession lets go,
                // whichever way this open ends. A Home that closes anyway, such as for a restore, runs the
                // callback, which closes the socket with the retry close. A Home that began to close after
                // getSharedDrive found it refuses with a 503.
                session.releaseHome = drive.holdHome(() =>
                    rawWs.close(COLLAB_STORAGE_UNAVAILABLE_CLOSE, COLLAB_STORAGE_UNAVAILABLE_REASON),
                );

                const document = await drive.getCollabDocument(mountId, pathId);
                rawWs.send(collabEpochMessage(ownerId));
                document.subscribe(user, rawWs);
                console.log(
                    `[collab] open path=${pathId} loadMs=${(performance.now() - loadStart).toFixed(0)} ` +
                        `connections=${document.connectionCount}`,
                );

                session.drive = drive;
                session.collabDocument = document;
                session.pingInterval = keepWebSocketAlive(user, rawWs, () => cleanupSession(session, rawWs));
            } catch (err) {
                const status = err instanceof ApiError ? err.status : 500;
                // A refusal, such as a document in the trash, is expected on every reconnect, so it gets one line.
                if (err instanceof ApiError && status < 500) {
                    console.log(`[collab] open refused path=${ws.data.params.pathId} status=${status}: ${err.message}`);
                } else {
                    console.error('Error opening collab session:', err);
                }
                // A failure HTTP would answer with a 5xx makes the client retry. That includes a home a restore
                // is replacing. If the restore finishes, the reconnect names a stale epoch and the tab reloads.
                // If it fails, the epoch stays, and the tab syncs the edits it holds.
                if (status >= 500) {
                    ws.close(COLLAB_STORAGE_UNAVAILABLE_CLOSE, COLLAB_STORAGE_UNAVAILABLE_REASON);
                } else if (status === 410) {
                    // Terminal: the stored object is gone, so the client stops retrying.
                    ws.close(COLLAB_STORAGE_GONE_CLOSE, COLLAB_STORAGE_GONE_REASON);
                } else {
                    ws.close(1008, 'Failed to open document');
                }
            } finally {
                stopHeartbeat?.();
                resolve();
            }
        },

        async message(ws, message) {
            if (typeof message === 'string') {
                if (message === 'ping') ws.send('pong');
                return;
            }

            // Bun delivers a binary frame as a Buffer, which is a Uint8Array. Anything else is not an update.
            if (!(message instanceof Uint8Array)) return;

            const session = sessions.get(ws.raw);
            if (!session) return;
            await session.opened;

            const { drive, collabDocument } = session;
            if (!drive || !collabDocument) return;

            try {
                const { mountId, pathId } = ws.data.params;
                const canWrite = await drive.canWrite(mountId, pathId, ws.data.user);
                collabDocument.handleMessage(ws.raw, message, canWrite);
            } catch (err) {
                console.error('Error processing collab message:', err);
            }
        },

        async close(ws, code) {
            const session = sessions.get(ws.raw);
            if (!session) return;
            await session.opened;
            const { collabDocument } = session;
            cleanupSession(session, ws.raw);
            // Counted after the unsubscribe: a Home teardown has already dropped every connection.
            if (collabDocument) {
                console.log(
                    `[collab] close path=${ws.data.params.pathId} code=${code} connections=${collabDocument.connectionCount}`,
                );
            }
        },
    });

function cleanupSession(session: CollabSession, ws: ServerWebSocket<unknown>): void {
    if (session.pingInterval) clearInterval(session.pingInterval);
    session.pingInterval = undefined;
    session.collabDocument?.unsubscribe(ws);
    session.collabDocument = undefined;
    session.releaseHome?.();
    session.releaseHome = undefined;
}
