// The collab routes: a document's access info and comment index over HTTP, and the WebSocket each editor opens to sync
// a document. The socket checks read and its session when it opens and on its keepalive, and write on every message,
// and it hands the frames to the CollabDocument the Drive keeps open for that document.

import {
    COLLAB_ACCESS_LOST_CLOSE,
    COLLAB_ACCESS_LOST_REASON,
    COLLAB_HOME_REPLACED_CLOSE,
    COLLAB_HOME_REPLACED_REASON,
    COLLAB_STORAGE_GONE_CLOSE,
    COLLAB_STORAGE_GONE_REASON,
    COLLAB_STORAGE_UNAVAILABLE_CLOSE,
    COLLAB_STORAGE_UNAVAILABLE_REASON,
} from '@workspace/lib/constants/collab';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import { Elysia, t } from 'elysia';
import type { ServerWebSocket } from 'elysia/ws/bun';
import { withCommentIndex } from '../lib/chat';
import type { CollabDocument } from '../lib/collab/collab-document';
import { collabEpochMessage } from '../lib/collab/epoch';
import { startLoadingHeartbeat } from '../lib/collab/loading-heartbeat';
import { ApiError } from '../lib/core/errors';
import { getSharedDrive } from '../lib/drive';
import type { DriveLike } from '../lib/drive/get-drive';
import { getDataEpoch } from '../lib/home/data-epoch';
import { getSessionUser } from '../lib/user';
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

// A user may open a document in another owner's drive, and getSharedDrive's checks decide what they may do there. The
// WebSocket server options are set on the root app, because Elysia reads `websocket` config only there.
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
            await drive.setCommentStatus(params.mountId, params.pathId, params.chatName, body.status, user, body.title);
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
            await drive.assignComment(params.mountId, params.pathId, params.chatName, body.assignee, user, body.title);
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

                // y-websocket gives up on a socket silent for 30 seconds, and a cold Home is the slowest step, so the
                // heartbeat starts first. Its frame is a constant, so it reveals nothing before the access check.
                const rawWs = ws.raw;
                stopHeartbeat = startLoadingHeartbeat(rawWs);
                const loadStart = performance.now();

                const { ownerId, mountId, pathId } = ws.data.params;
                const drive = await getSharedDrive(ownerId, user);
                // A stale epoch's sync would bring back what a restore undid. This comes after getSharedDrive's 503 for
                // a running restore, so no tab reloads onto that 503.
                const { epoch } = ws.data.query;
                if (epoch !== undefined && epoch !== getDataEpoch(ownerId)) {
                    ws.close(COLLAB_HOME_REPLACED_CLOSE, COLLAB_HOME_REPLACED_REASON);
                    return;
                }
                if (!(await drive.canRead(mountId, pathId, user))) {
                    ws.close(COLLAB_ACCESS_LOST_CLOSE, COLLAB_ACCESS_LOST_REASON);
                    return;
                }
                // Only a user who may read holds the Home, until cleanupSession lets go. A Home that closes anyway,
                // such as for a restore, closes the socket with the retry close.
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
                const authSessionId = ws.data.session.id;
                const checkAccess = async () => {
                    // The row, not the user the socket opened with: an ACL entry outlives its user, and matches on
                    // the email.
                    const current = await getSessionUser(authSessionId);
                    if (current && (await drive.canRead(mountId, pathId, current))) return;
                    rawWs.close(COLLAB_ACCESS_LOST_CLOSE, COLLAB_ACCESS_LOST_REASON);
                    cleanupSession(session, rawWs);
                };
                // The ping keeps a proxy from dropping the connection. A check that throws says nothing about the
                // access, so the socket stays and the next tick asks again.
                session.pingInterval = setInterval(async () => {
                    if (rawWs.readyState !== WebSocket.OPEN) {
                        cleanupSession(session, rawWs);
                        return;
                    }
                    try {
                        rawWs.ping();
                        await checkAccess();
                    } catch (err) {
                        console.error('Error in collab keepalive:', err);
                    }
                }, 15_000);

                // A change during the load is found now, not at the first tick. A frame that waits for `opened` finds
                // no document once the session is cleaned up.
                await checkAccess();
            } catch (err) {
                const status = err instanceof ApiError ? err.status : 500;
                // A refusal, such as a document in the trash, is expected on every reconnect, so it gets one line.
                if (err instanceof ApiError && status < 500) {
                    console.log(`[collab] open refused path=${ws.data.params.pathId} status=${status}: ${err.message}`);
                } else {
                    console.error('Error opening collab session:', err);
                }
                // A 5xx makes the client retry, a home a restore is replacing included: the reconnect then names a
                // stale epoch and reloads, or, if the restore never rotated it, syncs the edits it holds.
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
    clearInterval(session.pingInterval);
    session.collabDocument?.unsubscribe(ws);
    session.collabDocument = undefined;
    session.releaseHome?.();
    session.releaseHome = undefined;
}
