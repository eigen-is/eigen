import { restoreYjsDoc } from '@workspace/lib/collab/yjs-utils';
import { DRIVE_TYPE_STICKIES, type DrivePath, EIGEN_DOC_TYPE_INFO, isCollabType } from '@workspace/lib/types/drive';
import type { ServerWebSocket } from 'bun';
import { desc, lt, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { COMMENT_INDEX_DB_CONFIG } from '../chat/comment-db-config';
import type { ManagedDatabase } from '../core';
import { ApiError } from '../core/errors';
import type { Drive } from '../drive';
import type { User } from '../user';
import { compressBlob } from './blob-codec';
import { COLLAB_DB_CONFIG } from './db-config';
import * as schema from './schema';
import { loadYjsState } from './yjs-loader';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

const SNAPSHOT_INTERVAL = 100;
// Sheets' flushSnapshot dumps the whole sheet JSON into one update row on tab
// close; a count-only threshold lets data.db balloon to ~100× the doc size
// before consolidation. Trigger on bytes too so a single fat update collapses
// straight away. Bounds steady-state data.db to ~2× the doc.
const SNAPSHOT_BYTES = 1_000_000;
// In-DB checkpoint kept inside data.db so cold-open can hydrate from one row + tail updates.
// Long-term history lives under the container's `versions/` folder (see versioning routes).
const MAX_DOC_SNAPSHOTS = 1;
const TOUCH_THROTTLE_MS = 60_000;
// Grace between the last unsubscribe and teardown: an instant reconnect (tab
// reload, y-websocket's retry loop) reattaches to the loaded doc instead of
// re-paying S3 download + Yjs materialization — the amplification half of the
// 2026-08-04 reconnect spiral.
const CLOSE_LINGER_MS = 60_000;
// One 'edited' history row per user per window. Per-instance state, so a doc
// close+reopen within the window records an extra row — accepted spec trade-off.
const EDIT_RECORD_THROTTLE_MS = 10 * 60_000;

class DbProvider {
    private db: BunSQLiteDatabase<typeof schema>;
    private doc: Y.Doc;
    private label: string;
    private updatesSinceSnapshot = 0;
    private bytesSinceSnapshot = 0;
    private updateHandler: (update: Uint8Array) => void;

    constructor(doc: Y.Doc, label: string, managedDb: ManagedDatabase<typeof schema>) {
        this.db = managedDb.db;
        this.doc = doc;
        this.label = label;

        const { updatesApplied, bytesApplied } = loadYjsState(managedDb, this.doc, label);
        this.updatesSinceSnapshot = updatesApplied;
        this.bytesSinceSnapshot = bytesApplied;

        this.updateHandler = (update: Uint8Array) => {
            this.storeUpdate(update);
        };
        doc.on('update', this.updateHandler);
    }

    private storeUpdate(update: Uint8Array): void {
        try {
            this.db
                .insert(schema.docUpdates)
                .values({
                    updateData: compressBlob(update),
                })
                .run();
            this.updatesSinceSnapshot++;
            this.bytesSinceSnapshot += update.byteLength;

            if (this.updatesSinceSnapshot >= SNAPSHOT_INTERVAL || this.bytesSinceSnapshot >= SNAPSHOT_BYTES) {
                this.createSnapshot();
            }
        } catch (error) {
            // Never rethrow: 'update' handlers run inside yjs's transaction-cleanup
            // finally — a throw leaves the cleanup queue stale and silently wedges every
            // later update on this doc (no persistence, no broadcast). A later snapshot
            // self-heals the gap: it encodes the full doc state.
            console.error(`[DbProvider] Error storing update for ${this.label}:`, error);
        }
    }

    private createSnapshot(): void {
        try {
            const stateData = compressBlob(Y.encodeStateAsUpdate(this.doc));

            this.db.transaction((tx) => {
                const lastUpdate = tx
                    .select({ id: schema.docUpdates.id })
                    .from(schema.docUpdates)
                    .orderBy(desc(schema.docUpdates.id))
                    .limit(1)
                    .get();

                if (!lastUpdate) return;

                tx.insert(schema.docSnapshots)
                    .values({
                        stateData,
                        lastUpdateId: lastUpdate.id,
                    })
                    .run();

                tx.delete(schema.docUpdates).where(lte(schema.docUpdates.id, lastUpdate.id)).run();

                const allSnapshots = tx
                    .select({ id: schema.docSnapshots.id })
                    .from(schema.docSnapshots)
                    .orderBy(desc(schema.docSnapshots.id))
                    .all();

                if (allSnapshots.length > MAX_DOC_SNAPSHOTS) {
                    const cutoffId = allSnapshots[MAX_DOC_SNAPSHOTS - 1].id;
                    tx.delete(schema.docSnapshots).where(lt(schema.docSnapshots.id, cutoffId)).run();
                }
            });

            this.updatesSinceSnapshot = 0;
            this.bytesSinceSnapshot = 0;
        } catch (error) {
            // Swallow: the update rows all survive (deleted only inside the successful
            // transaction), and the un-reset counters make the next update retry.
            console.error(`[DbProvider] Error creating snapshot for ${this.label}:`, error);
        }
    }

    destroy(): void {
        this.doc.off('update', this.updateHandler);
        this.createSnapshot();
    }
}

// Yjs and awareness hand back whatever origin was passed in; ours is the socket, anything else is server-side.
function isConnection(origin: unknown): origin is ServerWebSocket<undefined> {
    return origin !== null && typeof origin === 'object' && 'readyState' in origin;
}

export default class CollabDocument {
    private drive: Drive;
    private path: DrivePath;
    // Exposed for server-side import/export dispatchers that write directly into the Yjs doc.
    // See docs/DOCUMENT-CONTENT-LAYER.md.
    public doc!: Y.Doc;
    private provider!: DbProvider;
    private awareness!: awarenessProtocol.Awareness;
    private connections: Map<ServerWebSocket<undefined>, User> = new Map();

    public get connectionCount(): number {
        return this.connections.size;
    }
    private connectionClientIds: Map<ServerWebSocket<undefined>, Set<number>> = new Map();
    private closed: boolean = false;
    private lastTouchedAt = 0;
    private lastEditRecordedAt: Map<string, number> = new Map(); // userId -> ts
    private closeTimer: ReturnType<typeof setTimeout> | undefined;
    private closeLingerMs = CLOSE_LINGER_MS;
    public dataDbPathId: string | null = null;

    constructor(drive: Drive, path: DrivePath) {
        this.drive = drive;
        this.path = path;
    }

    static async create(drive: Drive, mountId: string, docId: string): Promise<void> {
        // Atomic provisioning across both managed dbs. If comments.db fails
        // after data.db succeeded, the helper rolls both back so a retry of
        // the outer create() starts from a clean slate.
        await drive.provisionManagedDbs(mountId, docId, [
            { name: 'data.db', config: COLLAB_DB_CONFIG },
            { name: 'comments.db', config: COMMENT_INDEX_DB_CONFIG },
        ]);
        await drive.createFolder(mountId, docId, 'media');
        await drive.createFolder(mountId, docId, 'chat');
    }

    public async init(): Promise<CollabDocument> {
        let [dataDbPath, commentsDbPath] = await Promise.all([
            this.drive.getChildByName(this.path.mountId, this.path.id, 'data.db'),
            this.drive.getChildByName(this.path.mountId, this.path.id, 'comments.db'),
        ]);
        if (!dataDbPath) {
            await CollabDocument.create(this.drive, this.path.mountId, this.path.id);
            [dataDbPath, commentsDbPath] = await Promise.all([
                this.drive.getChildByName(this.path.mountId, this.path.id, 'data.db'),
                this.drive.getChildByName(this.path.mountId, this.path.id, 'comments.db'),
            ]);
            if (!dataDbPath) {
                throw new ApiError(500, `Failed to create data.db in ${this.path.name}`);
            }
        }

        // Speculatively warm comments.db so /comments hits Mount.documentDbs' cache.
        // Fire-and-forget: the /comments request will surface any genuine problem.
        if (commentsDbPath) {
            this.drive.openDatabase(this.path.mountId, COMMENT_INDEX_DB_CONFIG, commentsDbPath.id).catch(() => {});
        }

        const managedDb = await this.drive.openDatabase(this.path.mountId, COLLAB_DB_CONFIG, dataDbPath.id);
        this.dataDbPathId = dataDbPath.id;

        this.doc = new Y.Doc();
        this.doc.gc = true;
        this.provider = new DbProvider(this.doc, this.path.name, managedDb);
        this.awareness = new awarenessProtocol.Awareness(this.doc);

        this.doc.on('update', (update: Uint8Array, origin: unknown) => {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            syncProtocol.writeUpdate(encoder, update);
            const message = encoding.toUint8Array(encoder);
            const conn = isConnection(origin) ? origin : null;
            this.broadcastMessage(conn, message);
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
                const encoder = encoding.createEncoder();
                encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
                encoding.writeVarUint8Array(
                    encoder,
                    awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
                );
                this.broadcastMessage(isConnection(origin) ? origin : null, encoding.toUint8Array(encoder));
            },
        );

        return this;
    }

    private throttledTouchUpdatedAt(): void {
        const now = Date.now();
        if (now - this.lastTouchedAt < TOUCH_THROTTLE_MS) return;
        this.lastTouchedAt = now;
        this.drive.touchUpdatedAt(this.path.mountId, this.path.id).catch(() => {});
    }

    private recordEditThrottled(user: User): void {
        // Stickies activity is fully covered by specific sticky-*/comment events; a generic
        // 'edited' row would double-report every drag.
        if (this.path.type === DRIVE_TYPE_STICKIES) return;
        const now = Date.now();
        if (now - (this.lastEditRecordedAt.get(user.id) ?? 0) < EDIT_RECORD_THROTTLE_MS) return;
        this.lastEditRecordedAt.set(user.id, now);
        this.drive.recordFileEvent(this.path.mountId, this.path.id, user, { eventType: 'edited' }).catch(() => {});
    }

    public destruct() {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.closeTimer);
        this.drive.touchUpdatedAt(this.path.mountId, this.path.id).catch(() => {});
        for (const conn of this.connections.keys()) {
            conn.close();
        }
        this.connections.clear();
        this.provider.destroy();
        this.awareness.destroy();
        this.doc.destroy();
    }

    // Replaces the live Y.Doc's state with the snapshot's. Runs as one
    // transaction → one update → existing 'update' handler persists to data.db
    // and broadcasts to every connected WebSocket. Connected editors converge
    // live; disconnected sessions pick up the new state via the next sync
    // handshake. The caller (versioning/restore.ts) deliberately holds no
    // container lock: the surgery is synchronous, so nothing interleaves with it.
    public applySnapshotState(state: Uint8Array): void {
        // Internal invariants — the only caller (versioning/restore) already
        // branched on isCollabType, and every Yjs type declares yjsRoots.
        if (this.closed) throw new Error('applySnapshotState: CollabDocument is closed');
        if (!isCollabType(this.path.type)) {
            throw new Error(`applySnapshotState called on non-collab path ${this.path.type}`);
        }
        const roots = EIGEN_DOC_TYPE_INFO[this.path.type].yjsRoots;
        if (!roots) {
            throw new Error(`No yjsRoots schema declared for ${this.path.type}`);
        }
        restoreYjsDoc(this.doc, state, roots);
    }

    public subscribe(user: User, conn: ServerWebSocket<undefined>) {
        if (this.closed) {
            return;
        }
        clearTimeout(this.closeTimer);
        this.connections.set(conn, user);
        this.sendSyncStep1(conn);
    }

    public unsubscribe(conn: ServerWebSocket<undefined>) {
        if (this.closed) {
            return;
        }
        this.dropConnection(conn);

        for (const connection of this.connections.keys()) {
            if (connection.readyState >= WebSocket.CLOSING) {
                this.dropConnection(connection);
            }
        }
        if (this.connections.size === 0) {
            this.scheduleClose();
        }
    }

    private dropConnection(conn: ServerWebSocket<undefined>): void {
        this.connections.delete(conn);
        const clientIds = this.connectionClientIds.get(conn);
        if (clientIds && clientIds.size > 0) {
            awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(clientIds), null);
        }
        this.connectionClientIds.delete(conn);
    }

    private scheduleClose(): void {
        clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => {
            if (this.closed || this.connections.size > 0) return;
            this.drive.closeCollabDocument(this.path.mountId, this.path.id).catch(() => {});
        }, this.closeLingerMs);
        // A lingering doc must never hold the process open at shutdown.
        this.closeTimer.unref();
    }

    // Read is checked only when a connection opens (routes/collab.ts), whereas write is
    // re-checked per message. Enforcing read here on an ACL change restores the symmetry:
    // a user whose read was revoked is dropped from the live doc immediately, instead of
    // receiving broadcasts until they happen to disconnect. Called by Drive.updateACL.
    public async enforceReadAccess() {
        if (this.closed) {
            return;
        }
        // Snapshot: unsubscribe() mutates `connections` while we iterate.
        for (const [conn, user] of [...this.connections]) {
            if (!(await this.drive.canRead(this.path.mountId, this.path.id, user))) {
                conn.close(1008, 'Access revoked');
                this.unsubscribe(conn);
            }
        }
    }

    public handleMessage(conn: ServerWebSocket<undefined>, update: Uint8Array, canWrite: boolean) {
        if (this.closed) {
            return;
        }
        const decoder = decoding.createDecoder(update);
        const messageType = decoding.readVarUint(decoder);

        if (messageType === MESSAGE_SYNC) {
            const updateType = decoding.peekUint8(decoder);
            if (!canWrite && (updateType === 1 || updateType === 2)) {
                return;
            }

            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            syncProtocol.readSyncMessage(decoder, encoder, this.doc, conn);

            if (encoding.length(encoder) > 1) {
                const responseMessage = encoding.toUint8Array(encoder);
                conn.send(Buffer.from(responseMessage));
            }
        } else if (messageType === MESSAGE_AWARENESS) {
            const awarenessUpdate = decoding.readVarUint8Array(decoder);
            awarenessProtocol.applyAwarenessUpdate(this.awareness, awarenessUpdate, conn);

            try {
                const trackDecoder = decoding.createDecoder(awarenessUpdate);
                const len = decoding.readVarUint(trackDecoder);
                let ids = this.connectionClientIds.get(conn);
                if (!ids) {
                    ids = new Set();
                    this.connectionClientIds.set(conn, ids);
                }
                for (let i = 0; i < len; i++) {
                    ids.add(decoding.readVarUint(trackDecoder));
                }
            } catch {
                // ignore parsing errors
            }

            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
            encoding.writeVarUint8Array(encoder, awarenessUpdate);
            this.broadcastMessage(conn, encoding.toUint8Array(encoder));
        } else {
            console.warn(`Unknown message type: ${messageType}`);
        }
    }

    private broadcastMessage(originConn: ServerWebSocket<undefined> | null, message: Uint8Array): void {
        if (this.closed) {
            return;
        }
        for (const conn of this.connections.keys()) {
            if (conn !== originConn && conn.readyState === WebSocket.OPEN) {
                try {
                    conn.send(Buffer.from(message));
                } catch (err) {
                    console.error('Error sending message to client:', err);
                }
            }
        }
    }

    private sendSyncStep1(conn: ServerWebSocket<undefined>): void {
        try {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            syncProtocol.writeSyncStep1(encoder, this.doc);
            const syncMessage = encoding.toUint8Array(encoder);
            conn.send(Buffer.from(syncMessage));

            const awarenessStates = this.awareness.getStates();
            if (awarenessStates.size > 0) {
                const awarenessEncoder = encoding.createEncoder();
                encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
                encoding.writeVarUint8Array(
                    awarenessEncoder,
                    awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(awarenessStates.keys())),
                );

                const awarenessMessage = encoding.toUint8Array(awarenessEncoder);
                conn.send(Buffer.from(awarenessMessage));
            }
        } catch (err) {
            console.error('Error sending sync step 1:', err);
        }
    }
}
