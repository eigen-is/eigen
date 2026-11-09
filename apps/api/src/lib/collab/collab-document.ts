// One open collab document, such as a doc, a sheet or a deck, held in memory as a Y.Doc. It loads the document from
// its data.db, saves every edit back to it, and relays edits and cursors between the sockets that have it open.
// Server-side writers, such as an import or a version restore, edit the same Y.Doc, so every editor sees them. Drive
// opens each document once and closes it a while after the last socket leaves or after an open that no socket joins,
// holding its Home while it waits. Before that close, a workbook saves a version and folds its op log.

import { restoreYjsDoc } from '@workspace/lib/collab/yjs-utils';
import { isRecord } from '@workspace/lib/guards';
import { readSheetsBase, writeSheetsSnapshot } from '@workspace/lib/sheets';
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
import { restampRestoredSheetsBase, stampMissingSheetsBase } from '../document/sheets';
import { compactSheets, sheetsNeedCompaction } from '../document/sheets-compaction';
import type { Drive } from '../drive';
import {
    CONTAINER_CHAT_FOLDER,
    CONTAINER_COMMENTS_DB,
    CONTAINER_DATA_DB,
    CONTAINER_MEDIA_FOLDER,
} from '../mount/container-dbs';
import type { User } from '../user';
import { COLLAB_DB_CONFIG } from './db-config';
import { DbProvider } from './db-provider';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

// A tab that reconnects gets a new awareness client id, so a socket may own a few. The cap stops a flood that would
// grow the map every peer receives.
const MAX_AWARENESS_CLIENT_IDS = 8;
// A real awareness state is a name, a color, a user id and a cursor. That is a few hundred bytes, or a
// few KiB for a large canvas selection. The cap bounds what one state costs every peer.
const MAX_AWARENESS_STATE_BYTES = 16 * 1024;

// Bun negotiates permessage-deflate, but it only deflates a frame when send() asks. Without that, a
// large sheet's whole-state sync reply can't arrive within y-websocket's 30 s silence window on a slow link.
const COMPRESS_FRAME_MIN_BYTES = 1024;

// Typing fires many updates a second, so Modified is stamped at most once a minute.
const TOUCH_THROTTLE_MS = 60_000;
// How long a document with no socket stays open. A reload or a y-websocket retry within it
// reattaches to the loaded document instead of loading it again.
export const CLOSE_LINGER_MS = 60_000;
// A compaction's swap changes what is stored, not what the workbook shows, so it moves no Modified time.
const COMPACTION_ORIGIN = Symbol('compaction');
// One 'edited' history row per user per window. The window lives in memory, so a document that closes
// and opens again within it records an extra row. That is cheaper than storing the window.
const EDIT_RECORD_THROTTLE_MS = 10 * 60_000;

export class CollabDocument {
    private readonly awareness: awarenessProtocol.Awareness;
    private readonly connections = new Map<ServerWebSocket<unknown>, User>();
    // The awareness client ids each connection declared, and the connection that owns each id. Only the
    // owner may write or remove an id, so no peer can evict or overwrite another's cursor.
    private readonly connectionClientIds = new Map<ServerWebSocket<unknown>, Set<number>>();
    private readonly clientIdOwners = new Map<number, ServerWebSocket<unknown>>();
    private closed = false;
    private closeTimer: ReturnType<typeof setTimeout> | undefined;
    // The hold on the Home while the document lingers. Edits over a socket are no requests, so the Home's idle time
    // may be long past when the last socket leaves, and without the hold the Home would close under the linger.
    private releaseHome: (() => void) | null = null;
    private lastTouchedAt = 0;
    // The time of an update the touch throttle skipped. The close stamps it, so a document that was only
    // read keeps its Modified time, and the linger never shows as the time of the last edit.
    private untouchedUpdateAt: number | null = null;
    private readonly editRecordedAtByUser = new Map<string, number>();
    // Moves with every update, not with a subscribe. A compaction swaps its result in only while it hasn't moved since
    // the compaction read the document.
    private generation = 0;
    // The compaction in flight, which a destruct aborts.
    private compaction: AbortController | null = null;

    private constructor(
        private readonly drive: Drive,
        public readonly path: DrivePath,
        public readonly doc: Y.Doc,
        private readonly provider: DbProvider,
        public readonly dataDbPathId: string,
        // The hold on data.db, so a reader's idle close can't close it under the provider.
        private readonly releaseDataDb: () => void,
    ) {
        // The awareness starts an interval that only the doc's destroy stops, and a failed open is never destructed,
        // so it is made here, once the open can no longer fail.
        this.awareness = new awarenessProtocol.Awareness(doc);

        this.doc.on('update', (update: Uint8Array, origin: unknown) => {
            this.generation++;
            const conn = isConnection(origin) ? origin : null;
            this.broadcastMessage(
                conn,
                encodeFrame(MESSAGE_SYNC, (encoder) => syncProtocol.writeUpdate(encoder, update)),
            );
            const user = conn && this.connections.get(conn);
            if (user) this.recordEditThrottled(user);
            if (origin !== COMPACTION_ORIGIN) this.throttledTouchUpdatedAt();
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

        // A server-side writer, such as an import, opens a document that no socket may ever join. The
        // linger closes that one too, and a socket that subscribes cancels it.
        this.scheduleClose();
    }

    public get connectionCount(): number {
        return this.connections.size;
    }

    // Sets up a new document's container. If comments.db fails after data.db was made,
    // provisionManagedDbs removes both, so a retry starts clean.
    public static async create(drive: Drive, mountId: string, docId: string): Promise<void> {
        await drive.provisionManagedDbs(mountId, docId, [
            { name: CONTAINER_DATA_DB, config: COLLAB_DB_CONFIG },
            { name: CONTAINER_COMMENTS_DB, config: COMMENT_INDEX_DB_CONFIG },
        ]);
        await drive.createFolder(mountId, docId, CONTAINER_MEDIA_FOLDER);
        await drive.createFolder(mountId, docId, CONTAINER_CHAT_FOLDER);
    }

    public static async open(drive: Drive, path: DrivePath): Promise<CollabDocument> {
        const [dataDbPath, commentsDbPath] = await Promise.all([
            drive.getChildByName(path.mountId, path.id, CONTAINER_DATA_DB),
            drive.getChildByName(path.mountId, path.id, CONTAINER_COMMENTS_DB),
        ]);
        // A copy makes the container before it copies data.db into it. A socket that opens the copy in
        // between gets a 503 and tries again, so it never makes a data.db the copy then can't write.
        if (!dataDbPath) throw new ApiError(503, `${path.name} has no data.db yet`);

        // The editor asks for its comments right after the open, so comments.db opens now. Nothing waits for it and
        // nothing holds it, because that comments request reports any real problem itself.
        if (commentsDbPath) {
            drive
                .withDatabase(path.mountId, COMMENT_INDEX_DB_CONFIG, commentsDbPath.id, async () => {})
                .catch(() => {});
        }

        const dataDb = await drive.holdDatabase(path.mountId, COLLAB_DB_CONFIG, dataDbPath.id);
        const doc = new Y.Doc();
        let provider: DbProvider;
        try {
            provider = new DbProvider(doc, path.name, dataDb.db);
            // Before the document listens for updates, so the stamp is saved but moves no Modified time.
            stampMissingSheetsBase(path.type, doc);
        } catch (error) {
            // A document that fails to open is never destructed, so it lets go here.
            dataDb.release();
            throw error;
        }
        return new CollabDocument(drive, path, doc, provider, dataDbPath.id, dataDb.release);
    }

    // The provider writes a last snapshot as it stops, and then this lets go of data.db. So the caller
    // closes data.db only after this.
    public destruct(): void {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.closeTimer);
        this.releaseLingerHold();
        this.compaction?.abort();
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
        this.releaseDataDb();
        this.awareness.destroy();
        this.doc.destroy();
    }

    public subscribe(user: User, conn: ServerWebSocket<unknown>): void {
        // A mount sweep can close a document while a socket still waits for it to load. That socket
        // gets a 503 and connects again, to a new document.
        if (this.closed) throw new ApiError(503, 'Document is closing');
        clearTimeout(this.closeTimer);
        this.releaseLingerHold();
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

    // One synchronous Yjs transaction, so it is saved and sent like any edit, nothing changes the document halfway,
    // and the caller needs no lock.
    public applySnapshotState(state: Uint8Array): void {
        if (this.closed) throw new Error('applySnapshotState: CollabDocument is closed');
        if (!isCollabType(this.path.type)) {
            throw new Error(`applySnapshotState called on non-collab path ${this.path.type}`);
        }
        const roots = EIGEN_DOC_TYPE_INFO[this.path.type].yjsRoots;
        if (!roots) throw new Error(`No yjsRoots schema declared for ${this.path.type}`);
        this.doc.transact(() => {
            restoreYjsDoc(this.doc, state, roots);
            restampRestoredSheetsBase(this.path.type, this.doc);
        });
    }

    private dropConnection(conn: ServerWebSocket<unknown>): void {
        this.connections.delete(conn);
        const clientIds = this.connectionClientIds.get(conn);
        if (clientIds) {
            // Its ids are freed, so a reconnecting tab that reuses one isn't locked out.
            for (const id of clientIds) this.clientIdOwners.delete(id);
            if (clientIds.size > 0) awarenessProtocol.removeAwarenessStates(this.awareness, [...clientIds], null);
        }
        this.connectionClientIds.delete(conn);
    }

    private scheduleClose(): void {
        clearTimeout(this.closeTimer);
        if (!this.releaseHome) {
            try {
                this.releaseHome = this.drive.holdHome();
            } catch {
                // A closing Home refuses the hold. Its close destructs this document anyway.
            }
        }
        this.closeTimer = setTimeout(() => {
            // A compaction in flight closes the document itself when it ends, or lingers it again.
            if (this.closed || this.connections.size > 0 || this.compaction) return;
            // A close that failed leaves the document open, and then the Home's own close ends it.
            this.closeAfterLinger().catch(() => this.releaseLingerHold());
        }, CLOSE_LINGER_MS);
        // A lingering document must never keep the process alive at shutdown.
        this.closeTimer.unref();
    }

    private releaseLingerHold(): void {
        this.releaseHome?.();
        this.releaseHome = null;
    }

    // A workbook folds its op log into its snapshot first. The registry still holds the document meanwhile, so a
    // socket that connects reattaches to it, and then the document stays open until the next linger.
    private async closeAfterLinger(): Promise<void> {
        if (sheetsNeedCompaction(this.path, this.doc)) {
            const generation = this.generation;
            this.compaction = new AbortController();
            // It resolves whatever the run's outcome, with null when there is no snapshot to swap in.
            const snapshot = await compactSheets(this.path, this.doc, this.compaction.signal);
            // The swap deletes the log, so a current result first gets a version that keeps it. Its wait for the
            // container lock while this holds data.db is safe, as every closer of a live document destructs it first.
            let saved = false;
            if (snapshot !== null && !this.closed && this.connections.size === 0 && this.generation === generation) {
                try {
                    await this.drive.saveVersion(this.path.mountId, this.path.id);
                    saved = true;
                } catch (err) {
                    console.warn(
                        `[sheets] version before compaction failed path=${this.path.id}, kept the log:`,
                        err instanceof Error ? err.message : err,
                    );
                }
            }
            this.compaction = null;
            if (this.closed || this.connections.size > 0) return;
            if (snapshot !== null) {
                // An update since the read, one during the version included, makes the result stale. The document
                // lingers again, and the next close tries again.
                if (this.generation !== generation) {
                    this.scheduleClose();
                    return;
                }
                // Nothing changed, so the op log holds just the batches the snapshot folded, and the swap drops them.
                // A version that failed stops the swap, and the document closes with its log, as after a failed run.
                if (saved) {
                    this.doc.transact(
                        () => writeSheetsSnapshot(this.doc, snapshot, readSheetsBase(this.doc)?.id ?? null),
                        COMPACTION_ORIGIN,
                    );
                    // The version is the session's only one. A final version of the folded state would be newer, so
                    // retention would keep it and drop the copy of the log.
                    await this.drive.closeCollabDocument(this.path.mountId, this.path.id, { skipFinalSnapshot: true });
                    return;
                }
            }
        }
        await this.drive.closeCollabDocument(this.path.mountId, this.path.id);
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

// A client may publish presence for itself only. A state without a `user`, such as the handshake's, claims no identity,
// and the display name is the client's choice.
function awarenessIdentityMatches(state: unknown, userId: string): boolean {
    if (!isRecord(state)) return true;
    const identity = state['user'];
    if (identity === undefined || identity === null) return true;
    return isRecord(identity) && identity['userId'] === userId;
}
