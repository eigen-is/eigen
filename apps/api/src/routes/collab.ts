// The collab routes: a document's access info, stored state and comment index over HTTP, and the WebSocket a live
// reader's editor opens to sync a document. The socket checks its session and that its user is a live reader when it
// opens and on its keepalive, and write on every message, and it hands the frames to the CollabDocument the Drive keeps
// open for that document. Any other reader, such as a visitor on a public link, gets the info and the stored state,
// and no socket. A socket that opens, or a stored state a signed-in reader loads, counts on the user's Recent page.

import { collabStateVersion } from '@workspace/lib/collab/collab-state';
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
import { isCollabType } from '@workspace/lib/types/drive';
import type { ElysiaCustomStatusResponse } from 'elysia';
import { Elysia, t } from 'elysia';
import type { ServerWebSocket } from 'elysia/ws/bun';
import { withCommentIndex } from '../lib/chat';
import type { CollabDocument } from '../lib/collab/collab-document';
import { collabEpochMessage } from '../lib/collab/epoch';
import { EMPTY_AWARENESS_MESSAGE, startLoadingHeartbeat } from '../lib/collab/loading-heartbeat';
import { ApiError } from '../lib/core/errors';
import { answerRevalidated } from '../lib/core/http';
import { readCollabStateVersion } from '../lib/document/transform/collab-source';
import { getReadDrive, getReaderAccess, getSharedDrive } from '../lib/drive';
import type { DriveLike } from '../lib/drive/get-drive';
import { recordOpened } from '../lib/drive/recent';
import { getDataEpoch } from '../lib/home/data-epoch';
import { COLLAB_STATE_FORMAT, getCollabState } from '../lib/preview/preview-cache';
import type { User } from '../lib/user';
import { getSessionUser } from '../lib/user';
import { betterAuth } from './auth';

// Who a socket opened as, with the drive that checks them.
type CollabAccess = { user: User; drive: DriveLike };

type CollabSession = {
    opened: Promise<void>;
    access?: CollabAccess;
    collabDocument?: CollabDocument;
    keepalive?: ReturnType<typeof setInterval>;
    releaseHome?: () => void;
};

// Elysia hands each socket event a new wrapper. Only the raw socket under it stays the same from open to
// close, and it has no typed field for this route's state, so the state lives in this map.
const sessions = new WeakMap<ServerWebSocket<unknown>, CollabSession>();

// A user may open a document in another owner's drive. The WebSocket server options are set on the root app, because
// Elysia reads `websocket` config only there.
export const collabRouter = new Elysia({
    name: 'collab',
})
    .use(betterAuth)

    .get(
        '/collab/:ownerId/:mountId/:pathId/info',
        async ({ params, user }): Promise<CollabDocumentInfo> => {
            const { canRead, canWrite, live } = await getReaderAccess(
                params.ownerId,
                params.mountId,
                params.pathId,
                user,
            );
            if (!canRead) return { canRead, canWrite, live, path: null, folderContents: null };
            const drive = await getReadDrive(params.ownerId, user);
            const path = await drive.getPath(params.mountId, params.pathId);
            const folderContents = await drive.getFolderContents(params.mountId, params.pathId);
            return { canRead, canWrite, live, path, folderContents };
        },
        { linkAuth: true },
    )

    // The document's whole state, read without opening the document. Its version is the ETag, read off the row ids
    // alone, so a 304 and a cached state read no blob.
    .get(
        '/collab/:ownerId/:mountId/:pathId/state',
        async ({ params, request, user, set }): Promise<Response | ElysiaCustomStatusResponse<304>> => {
            const drive = await getReadDrive(params.ownerId, user);
            const { mount, path } = await drive.resolveFile(params.mountId, params.pathId);
            const { type } = path;
            if (!isCollabType(type)) throw new ApiError(404, 'Document not found');
            const { snapshotId, lastUpdateId } = await readCollabStateVersion(mount, path);
            const epoch = getDataEpoch(params.ownerId);
            const version = collabStateVersion(epoch, snapshotId, lastUpdateId, COLLAB_STATE_FORMAT);
            const body = await answerRevalidated(request, set, `"${version}"`, async () => {
                const state = await getCollabState(
                    mount,
                    path,
                    type,
                    version,
                    async () => (await getReaderAccess(params.ownerId, params.mountId, params.pathId, user)).priority,
                );
                if (user) recordOpened(user, path);
                return new Response(state);
            });
            set.headers['Content-Type'] = 'application/octet-stream';
            return body;
        },
        { linkAuth: true },
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
                // y-websocket gives up on a socket silent for 30 seconds, and a cold Home is the slowest step, so the
                // heartbeat starts first. Its frame is a constant, so it reveals nothing before the access check.
                const rawWs = ws.raw;
                stopHeartbeat = startLoadingHeartbeat(rawWs);
                const loadStart = performance.now();

                const { ownerId, mountId, pathId } = ws.data.params;
                const { user } = ws.data;
                const drive = await getSharedDrive(ownerId, user);
                const sessionId = ws.data.session.id;
                // A stale epoch's sync would bring back what a restore undid. This comes after getSharedDrive's 503 for
                // a running restore, so no tab reloads onto that 503.
                const { epoch } = ws.data.query;
                if (epoch !== undefined && epoch !== getDataEpoch(ownerId)) {
                    ws.close(COLLAB_HOME_REPLACED_CLOSE, COLLAB_HOME_REPLACED_REASON);
                    return;
                }
                // Answers whether the socket keeps its access, and closes it when it doesn't.
                const checkAccess = async (current: User | null): Promise<boolean> => {
                    if (current !== null && (await drive.readerAccess(mountId, pathId, current)).live) return true;
                    rawWs.close(COLLAB_ACCESS_LOST_CLOSE, COLLAB_ACCESS_LOST_REASON);
                    cleanupSession(session, rawWs);
                    return false;
                };
                // Later checks read the session's row, not the user the socket opened with: an ACL entry outlives its
                // user, and matches on the email.
                const checkSession = async (): Promise<boolean> => checkAccess(await getSessionUser(sessionId));
                if (!(await checkAccess(user))) return;
                // Only a live reader holds the Home, until cleanupSession lets go. A Home that closes anyway,
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

                session.access = { user, drive };
                session.collabDocument = document;
                // The heartbeat keeps a proxy from dropping the connection, and y-websocket from closing a quiet one,
                // which a protocol ping does not. A check that throws says nothing about the access, so the socket
                // stays and the next tick asks again.
                session.keepalive = setInterval(async () => {
                    if (rawWs.readyState !== WebSocket.OPEN) {
                        cleanupSession(session, rawWs);
                        return;
                    }
                    try {
                        rawWs.send(Buffer.from(EMPTY_AWARENESS_MESSAGE));
                        await checkSession();
                    } catch (err) {
                        console.error('Error in collab keepalive:', err);
                    }
                }, 15_000);

                // A change during the load is found now, not at the first tick. A frame that waits for `opened` finds
                // no document once the session is cleaned up. Only an open that keeps its access counts on Recent.
                if (!(await checkSession())) return;
                recordOpened(user, document.path);
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

            const { access, collabDocument } = session;
            if (!access || !collabDocument) return;

            try {
                const { mountId, pathId } = ws.data.params;
                const canWrite = await access.drive.canWrite(mountId, pathId, access.user);
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
    clearInterval(session.keepalive);
    session.collabDocument?.unsubscribe(ws);
    session.collabDocument = undefined;
    session.releaseHome?.();
    session.releaseHome = undefined;
}
