import type { User } from 'better-auth/types';
import type { ServerWebSocket } from 'bun';
import { Elysia, t } from 'elysia';
import { getCommentIndex } from '../lib/chat/comment-index.ts';
import type CollabDocument from '../lib/collab/collabDocument.ts';
import { ApiError } from '../lib/core/errors.ts';
import { getSharedDrive } from '../lib/drive';
import type Drive from '../lib/drive/drive.ts';
import type SharedDrive from '../lib/drive/sharedDrive.ts';
import { keepWebSocketAlive } from '../utils/websockets.ts';
import { betterAuth } from './auth';

type CollabWsData = {
    user?: User;
    params: { ownerId: string; mountId: string; pathId: string };
    drive?: Drive | SharedDrive;
    collabDocument?: CollabDocument;
    pingInterval?: ReturnType<typeof setInterval>;
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
export const collabRouter = new Elysia({
    name: 'collab',
    websocket: {
        perMessageDeflate: true,
        maxPayloadLength: 4 * 1024 * 1024,
    },
})
    .use(betterAuth)

    .get(
        '/collab/:ownerId/:mountId/:pathId/info',
        async ({ params, user }) => {
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
        '/collab/:ownerId/:mountId/:pathId/revisions',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            if (!(await drive.canRead(params.mountId, params.pathId, user))) {
                throw new ApiError(403, 'No read permission');
            }
            const document = await drive.getCollabDocument(params.mountId, params.pathId);
            return { revisions: document.getRevisions() };
        },
        { auth: true },
    )

    .get(
        '/collab/:ownerId/:mountId/:pathId/revisions/:revisionId',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            if (!(await drive.canRead(params.mountId, params.pathId, user))) {
                throw new ApiError(403, 'No read permission');
            }
            const document = await drive.getCollabDocument(params.mountId, params.pathId);
            const revisionId = Number(params.revisionId);
            if (!Number.isInteger(revisionId) || revisionId <= 0) {
                throw new ApiError(400, 'Invalid revision ID');
            }
            const state = document.getRevisionState(revisionId);
            if (!state) {
                throw new ApiError(404, 'Revision not found');
            }
            return new Response(Buffer.from(state), {
                headers: { 'Content-Type': 'application/octet-stream' },
            });
        },
        {
            auth: true,
            params: t.Object({
                ownerId: t.String(),
                mountId: t.String(),
                pathId: t.String(),
                revisionId: t.String({ pattern: '^[0-9]+$' }),
            }),
        },
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
        '/collab/:ownerId/:mountId/:pathId/comments/unresolved-count',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const index = await getCommentIndex(drive, params.mountId, params.pathId);
            return { count: await index.unresolvedCount() };
        },
        { auth: true },
    )

    .patch(
        '/collab/:ownerId/:mountId/:pathId/comments/:chatName/status',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            if (!(await drive.canWrite(params.mountId, params.pathId, user))) {
                throw new ApiError(403, 'No write permission');
            }
            const index = await getCommentIndex(drive, params.mountId, params.pathId);
            if (body.status === 'resolved') {
                await index.resolve(params.chatName, user.email);
            } else {
                await index.reopen(params.chatName);
            }
            return { success: true };
        },
        {
            body: t.Object({ status: t.Union([t.Literal('resolved'), t.Literal('open')]) }),
            auth: true,
        },
    )

    .ws('/ws/collab/:ownerId/:mountId/:pathId', {
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
                ws.close(1008, 'Authentication failed');
                return;
            }

            const { ownerId, mountId, pathId } = data.params;
            const drive = await getSharedDrive(ownerId, user);
            if (!drive || !(await drive.canRead(mountId, pathId, user))) {
                ws.close(1008, 'Authentication failed');
                return;
            }

            try {
                const document = await drive.getCollabDocument(mountId, pathId);
                const rawWs = ws as unknown as ServerWebSocket<undefined>;
                document.subscribe(user, rawWs);

                data.drive = drive;
                data.collabDocument = document;
                data.pingInterval = keepWebSocketAlive(user, rawWs, () => cleanupSession(data, rawWs));
            } catch (err) {
                console.error('Error getting document:', err);
                ws.close(1008, 'Failed to get document');
            }
        },

        async message(ws, message) {
            if (typeof message === 'string') {
                if (message === 'ping') ws.send('pong');
                return;
            }

            const data = ws.data as unknown as CollabWsData;
            if (!data.user || !data.collabDocument) return;

            try {
                const update = message instanceof Uint8Array ? message : new Uint8Array(message as Buffer);
                const { mountId, pathId } = data.params;
                const drive = data.drive ?? (await getSharedDrive(data.params.ownerId, data.user));
                const canWrite = await drive.canWrite(mountId, pathId, data.user);
                data.collabDocument.handleMessage(ws as unknown as ServerWebSocket<undefined>, update, canWrite);
            } catch (err) {
                console.error('Error processing message:', err);
            }
        },

        close(ws) {
            const data = ws.data as unknown as CollabWsData;
            cleanupSession(data, ws as unknown as ServerWebSocket<undefined>);
        },
    });
