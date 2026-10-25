// One open collab document, such as a doc, a sheet or a deck, held in memory as a Y.Doc. It loads the
// document from its data.db, saves every edit back to it, and relays edits and cursors between the
// sockets that have it open. Server-side writers, such as an import or a version restore, edit the
// same Y.Doc, so their changes reach every editor too. The Drive opens each document once, however
// many sockets connect, and closes it a while after the last one leaves.

import { restoreYjsDoc } from '@workspace/lib/collab/yjs-utils';
import { isRecord } from '@workspace/lib/guards';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_STICKIES, EIGEN_DOC_TYPE_INFO, isCollabType } from '@workspace/lib/types/drive';
import type { ServerWebSocket } from 'elysia/ws/bun';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { COMMENT_INDEX_DB_CONFIG } from '../chat/comment-db-config';
import { ApiError } from '../core/errors';
import type { Drive } from '../drive';
import type { User } from '../user';
import { COLLAB_DB_CONFIG } from './db-config';
import { DbProvider } from './db-provider';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

// A y-websocket client owns one awareness client id per document, and a tab that reconnects opens a
// new socket with a new id. So 8 ids per socket tolerate a client that changes its id a few times.
// The cap stops a flood that would grow the map every peer receives.
const MAX_AWARENESS_CLIENT_IDS = 8;
// A real awareness state is a name, a color, a user id and a cursor. That is a few hundred bytes, or a
// few KiB for a large canvas selection. The cap bounds what one state costs every peer.
const MAX_AWARENESS_STATE_BYTES = 16 * 1024;

// Bun negotiates permessage-deflate, but it only deflates a frame when send() asks. Without that, a
// large sheet's whole-state sync reply can't arrive within y-websocket's 30 s silence window on a slow link.
const COMPRESS_FRAME_MIN_BYTES = 1024;

// Typing fires many updates a second, so Modified is stamped at most once a minute.
const TOUCH_THROTTLE_MS = 60_000;
// The wait between the last unsubscribe and the close. A reload or a y-websocket retry within it
// reattaches to the loaded document instead of loading it again.
const CLOSE_LINGER_MS = 60_000;
// One 'edited' history row per user per window. The window lives in memory, so a document that closes
// and opens again within it records an extra row. That is cheaper than storing the window.
const EDIT_RECORD_THROTTLE_MS = 10 * 60_000;

function encodeFrame(messageType: number, write: (encoder: encoding.Encoder) => void): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageType);
    write(encoder);
    return encoding.toUint8Array(encoder);
}

function sendFrame(conn: ServerWebSocket<unknown>, message: Uint8Array): void {
    conn.send(Buffer.from(message), message.byteLength >= COMPRESS_FRAME_MIN_BYTES);
}

// Yjs and awareness hand back whatever origin the change was made with. A socket means a peer made
// it, anything else means the server did.
function isConnection(origin: unknown): origin is ServerWebSocket<unknown> {
    return origin !== null && typeof origin === 'object' && 'readyState' in origin;
}

// A client may publish presence for itself only, so the `user` in its awareness state must carry the
// session user's id. The display name is the client's choice. A state without a `user`, such as the
// empty one of the handshake, claims no identity.
function awarenessIdentityMatches(state: unknown, userId: string): boolean {
    if (!isRecord(state)) return true;
    const identity = state['user'];
    if (identity === undefined || identity === null) return true;
    return isRecord(identity) && identity['userId'] === userId;
}

export class CollabDocument {
    public readonly doc = new Y.Doc();
    public dataDbPathId: string | null = null;
    private readonly drive: Drive;
    private readonly path: DrivePath;
    private provider!: DbProvider;
    private awareness!: awarenessProtocol.Awareness;
    private readonly connections = new Map<ServerWebSocket<unknown>, User>();
    // The awareness client ids each connection declared, and the connection that owns each id. Only the
    // owner may write or remove an id, so no peer can evict or overwrite another's cursor.
    private readonly connectionClientIds = new Map<ServerWebSocket<unknown>, Set<number>>();
    private readonly clientIdOwners = new Map<number, ServerWebSocket<unknown>>();
    private closed = false;
    private closeTimer: ReturnType<typeof setTimeout> | undefined;
    private closeLingerMs = CLOSE_LINGER_MS;
    private lastTouchedAt = 0;
    // The time of an update the touch throttle skipped. The close stamps it, so a document that was only
    // read keeps its Modified time, and the linger never shows as the time of the last edit.
    private untouchedUpdateAt: number | null = null;
    private readonly editRecordedAtByUser = new Map<string, number>();

    public constructor(drive: Drive, path: DrivePath) {
        this.drive = drive;
        this.path = path;
    }

    public get connectionCount(): number {
        return this.connections.size;
    }

    // Sets up a new document's container. If comments.db fails after data.db was made,
    // provisionManagedDbs removes both, so a retry starts clean.
    public static async create(drive: Drive, mountId: string, docId: string): Promise<void> {
        await drive.provisionManagedDbs(mountId, docId, [
            { name: 'data.db', config: COLLAB_DB_CONFIG },
            { name: 'comments.db', config: COMMENT_INDEX_DB_CONFIG },
        ]);
        await drive.createFolder(mountId, docId, 'media');
        await drive.createFolder(mountId, docId, 'chat');
    }

    public async init(): Promise<CollabDocument> {
        const [dataDbPath, commentsDbPath] = await Promise.all([
            this.drive.getChildByName(this.path.mountId, this.path.id, 'data.db'),
            this.drive.getChildByName(this.path.mountId, this.path.id, 'comments.db'),
        ]);
        // A copy makes the container before it copies data.db into it. A socket that opens the copy in
        // between gets a 503 and tries again, so it never makes a data.db the copy then can't write.
        if (!dataDbPath) throw new ApiError(503, `${this.path.name} has no data.db yet`);

        // comments.db opens now, so the editor's first comments request finds it ready. Nothing waits for
        // it, because that request reports any real problem itself.
        if (commentsDbPath) {
            this.drive.openDatabase(this.path.mountId, COMMENT_INDEX_DB_CONFIG, commentsDbPath.id).catch(() => {});
        }

        const managedDb = await this.drive.openDatabase(this.path.mountId, COLLAB_DB_CONFIG, dataDbPath.id);
        this.dataDbPathId = dataDbPath.id;

        this.provider = new DbProvider(this.doc, this.path.name, managedDb);
        this.awareness = new awarenessProtocol.Awareness(this.doc);

        this.doc.on('update', (update: Uint8Array, origin: unknown) => {
            const conn = isConnection(origin) ? origin : null;
            this.broadcastMessage(
                conn,
                encodeFrame(MESSAGE_SYNC, (encoder) => syncProtocol.writeUpdate(encoder, update)),
            );
            const user = conn && this.connections.get(conn);
            if (user) this.recordEditThrottled(user);
            this.throttledTouchUpdatedAt();
        });

        this.awareness.on(
            'update',
            (
                { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
                origin: unknown,
            ) => {
                const changedClients = added.concat(updated, removed);
                if (changedClients.length === 0) return;
                this.broadcastMessage(isConnection(origin) ? origin : null, this.encodeAwareness(changedClients));
            },
        );

        return this;
    }

    // The provider writes a last snapshot as it stops, so data.db closes after this, never before.
    public destruct(): void {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.closeTimer);
        if (this.untouchedUpdateAt !== null) {
            this.drive
                .touchUpdatedAt(this.path.mountId, this.path.id, new Date(this.untouchedUpdateAt))
                .catch(() => {});
        }
        for (const conn of this.connections.keys()) {
            conn.close();
        }
        this.connections.clear();
        this.provider.destroy();
        this.awareness.destroy();
        this.doc.destroy();
    }

    public subscribe(user: User, conn: ServerWebSocket<unknown>): void {
        // A mount sweep can close a document while a socket still waits for it to load. That socket
        // gets a 503 and connects again, to a new document.
        if (this.closed) throw new ApiError(503, 'Document is closing');
        clearTimeout(this.closeTimer);
        this.connections.set(conn, user);
        this.sendSyncStep1(conn);
    }

    public unsubscribe(conn: ServerWebSocket<unknown>): void {
        if (this.closed) return;
        this.dropConnection(conn);
        // Sockets that are already closing go too, so they don't hold off the close.
        for (const connection of this.connections.keys()) {
            if (connection.readyState >= WebSocket.CLOSING) this.dropConnection(connection);
        }
        if (this.connections.size === 0) this.scheduleClose();
    }

    // Read is checked once, when a socket opens, while write is checked on every message. So when
    // sharing changes, the Drive calls this to drop each user who may no longer read. Otherwise they
    // would keep receiving edits until they disconnect.
    public async enforceReadAccess(): Promise<void> {
        if (this.closed) return;
        // A copy, because unsubscribe changes the map.
        for (const [conn, user] of [...this.connections]) {
            if (!(await this.drive.canRead(this.path.mountId, this.path.id, user))) {
                conn.close(1008, 'Access revoked');
                this.unsubscribe(conn);
            }
        }
    }

    public handleMessage(conn: ServerWebSocket<unknown>, message: Uint8Array, canWrite: boolean): void {
        if (this.closed) return;
        const decoder = decoding.createDecoder(message);
        const messageType = decoding.readVarUint(decoder);

        if (messageType === MESSAGE_SYNC) {
            // A reader still gets the handshake. Only a step 2 or an update changes the document.
            const syncType = decoding.peekUint8(decoder);
            if (
                !canWrite &&
                (syncType === syncProtocol.messageYjsSyncStep2 || syncType === syncProtocol.messageYjsUpdate)
            ) {
                return;
            }
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            syncProtocol.readSyncMessage(decoder, encoder, this.doc, conn);
            // Only a step 1 has a reply.
            if (encoding.length(encoder) > 1) sendFrame(conn, encoding.toUint8Array(encoder));
        } else if (messageType === MESSAGE_AWARENESS) {
            const awarenessUpdate = decoding.readVarUint8Array(decoder);
            const user = this.connections.get(conn);
            if (!user) return;

            // A reader may send awareness too, so the update is checked before it is applied. Any entry
            // that breaks a rule drops the whole frame.
            const owned = new Set(this.connectionClientIds.get(conn));
            const removed: number[] = [];
            try {
                const entries = decoding.createDecoder(awarenessUpdate);
                const count = decoding.readVarUint(entries);
                for (let i = 0; i < count; i++) {
                    const clientId = decoding.readVarUint(entries);
                    decoding.readVarUint(entries); // the clock
                    const stateJson = decoding.readVarString(entries);
                    const ownerConn = this.clientIdOwners.get(clientId);
                    if (ownerConn !== undefined && ownerConn !== conn) return;
                    if (stateJson === 'null') {
                        removed.push(clientId);
                        continue;
                    }
                    if (Buffer.byteLength(stateJson) > MAX_AWARENESS_STATE_BYTES) return;
                    if (!awarenessIdentityMatches(JSON.parse(stateJson), user.id)) return;
                    owned.add(clientId);
                    if (owned.size > MAX_AWARENESS_CLIENT_IDS) return;
                }
            } catch {
                return; // a malformed frame
            }

            // Applying fires the awareness 'update' handler, which sends the change to the other peers.
            awarenessProtocol.applyAwarenessUpdate(this.awareness, awarenessUpdate, conn);
            // A removed id is freed, so a client that recycles its ids never gets stuck at the cap.
            for (const id of removed) {
                owned.delete(id);
                this.clientIdOwners.delete(id);
            }
            for (const id of owned) this.clientIdOwners.set(id, conn);
            this.connectionClientIds.set(conn, owned);
        } else {
            console.warn(`Unknown message type: ${messageType}`);
        }
    }

    // Replaces the document's state with a version's, for a version restore. It runs as one Yjs
    // transaction, so it makes one update, which is saved and sent to every editor like any edit. It is
    // synchronous, so nothing can change the document halfway, and the caller needs no lock.
    public applySnapshotState(state: Uint8Array): void {
        if (this.closed) throw new Error('applySnapshotState: CollabDocument is closed');
        if (!isCollabType(this.path.type)) {
            throw new Error(`applySnapshotState called on non-collab path ${this.path.type}`);
        }
        const roots = EIGEN_DOC_TYPE_INFO[this.path.type].yjsRoots;
        if (!roots) throw new Error(`No yjsRoots schema declared for ${this.path.type}`);
        restoreYjsDoc(this.doc, state, roots);
    }

    private dropConnection(conn: ServerWebSocket<unknown>): void {
        this.connections.delete(conn);
        const clientIds = this.connectionClientIds.get(conn);
        if (clientIds) {
            // Freed, so a reconnecting tab that reuses its client id isn't locked out.
            for (const id of clientIds) this.clientIdOwners.delete(id);
            if (clientIds.size > 0) awarenessProtocol.removeAwarenessStates(this.awareness, [...clientIds], null);
        }
        this.connectionClientIds.delete(conn);
    }

    private scheduleClose(): void {
        clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => {
            if (this.closed || this.connections.size > 0) return;
            this.drive.closeCollabDocument(this.path.mountId, this.path.id).catch(() => {});
        }, this.closeLingerMs);
        // A lingering document must never keep the process alive at shutdown.
        this.closeTimer.unref();
    }

    private sendSyncStep1(conn: ServerWebSocket<unknown>): void {
        try {
            sendFrame(
                conn,
                encodeFrame(MESSAGE_SYNC, (encoder) => syncProtocol.writeSyncStep1(encoder, this.doc)),
            );
            const awarenessStates = this.awareness.getStates();
            if (awarenessStates.size > 0) sendFrame(conn, this.encodeAwareness([...awarenessStates.keys()]));
        } catch (err) {
            console.error('Error sending sync step 1:', err);
        }
    }

    private broadcastMessage(originConn: ServerWebSocket<unknown> | null, message: Uint8Array): void {
        if (this.closed) return;
        for (const conn of this.connections.keys()) {
            if (conn !== originConn && conn.readyState === WebSocket.OPEN) {
                try {
                    sendFrame(conn, message);
                } catch (err) {
                    console.error('Error sending message to client:', err);
                }
            }
        }
    }

    private encodeAwareness(clientIds: number[]): Uint8Array {
        return encodeFrame(MESSAGE_AWARENESS, (encoder) =>
            encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clientIds)),
        );
    }

    private throttledTouchUpdatedAt(): void {
        const now = Date.now();
        if (now - this.lastTouchedAt < TOUCH_THROTTLE_MS) {
            this.untouchedUpdateAt = now;
            return;
        }
        this.lastTouchedAt = now;
        this.untouchedUpdateAt = null;
        this.drive.touchUpdatedAt(this.path.mountId, this.path.id, new Date(now)).catch(() => {});
    }

    private recordEditThrottled(user: User): void {
        // A stickies board records its own event for every action, so an 'edited' row would report
        // each drag twice.
        if (this.path.type === DRIVE_TYPE_STICKIES) return;
        const now = Date.now();
        if (now - (this.editRecordedAtByUser.get(user.id) ?? 0) < EDIT_RECORD_THROTTLE_MS) return;
        this.editRecordedAtByUser.set(user.id, now);
        this.drive.recordFileEvent(this.path.mountId, this.path.id, user, { eventType: 'edited' }).catch(() => {});
    }
}
