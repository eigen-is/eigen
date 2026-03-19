import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import {type ServerWebSocket} from "bun";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import {desc, eq, gt, lt, lte} from "drizzle-orm";
import type {DrivePath} from "@workspace/lib/types/drive";
import type {Drive} from "../drive";
import type {ManagedDatabase} from "../core";
import {COLLAB_DB_CONFIG} from "./db-config";
import * as schema from "./schema.ts";
import type {User} from "better-auth/types";
import type {BunSQLiteDatabase} from "drizzle-orm/bun-sqlite";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const SNAPSHOT_INTERVAL = 100;
const MAX_REVISIONS = 50;

class DbProvider {
    private db: BunSQLiteDatabase<typeof schema>;
    private doc: Y.Doc;
    private docId: string;
    private updatesSinceSnapshot = 0;
    private updateHandler: (update: Uint8Array) => void;

    constructor(doc: Y.Doc, docId: string, managedDb: ManagedDatabase<typeof schema>) {
        this.db = managedDb.db;
        this.doc = doc;
        this.docId = docId;

        this.loadState();

        this.updateHandler = (update: Uint8Array) => {
            this.storeUpdate(update);
        };
        doc.on('update', this.updateHandler);
    }

    private loadState(): void {
        const snapshot = this.db.select().from(schema.docSnapshots)
            .orderBy(desc(schema.docSnapshots.id))
            .limit(1)
            .get();

        if (snapshot) {
            Y.applyUpdate(this.doc, snapshot.stateData as Uint8Array);

            const updates = this.db.select().from(schema.docUpdates)
                .where(gt(schema.docUpdates.id, snapshot.lastUpdateId))
                .all();
            for (const update of updates) {
                Y.applyUpdate(this.doc, update.updateData as Uint8Array);
            }
            this.updatesSinceSnapshot = updates.length;
        } else {
            const updates = this.db.select().from(schema.docUpdates).all();
            for (const update of updates) {
                Y.applyUpdate(this.doc, update.updateData as Uint8Array);
            }
            this.updatesSinceSnapshot = updates.length;
        }
    }

    private storeUpdate(update: Uint8Array): void {
        try {
            this.db.insert(schema.docUpdates).values({
                updateData: Buffer.from(update)
            }).run();
            this.updatesSinceSnapshot++;

            if (this.updatesSinceSnapshot >= SNAPSHOT_INTERVAL) {
                this.createSnapshot();
            }
        } catch (error) {
            console.error(`[DbProvider] Error storing update for ${this.docId}:`, error);
        }
    }

    private createSnapshot(): void {
        try {
            const stateData = Buffer.from(Y.encodeStateAsUpdate(this.doc));

            const lastUpdate = this.db.select({id: schema.docUpdates.id}).from(schema.docUpdates)
                .orderBy(desc(schema.docUpdates.id))
                .limit(1)
                .get();

            if (!lastUpdate) return;

            this.db.insert(schema.docSnapshots).values({
                stateData,
                lastUpdateId: lastUpdate.id,
            }).run();

            this.db.delete(schema.docUpdates)
                .where(lte(schema.docUpdates.id, lastUpdate.id))
                .run();

            const allSnapshots = this.db.select({id: schema.docSnapshots.id}).from(schema.docSnapshots)
                .orderBy(desc(schema.docSnapshots.id))
                .all();

            if (allSnapshots.length > MAX_REVISIONS) {
                const cutoffId = allSnapshots[MAX_REVISIONS - 1].id;
                this.db.delete(schema.docSnapshots)
                    .where(lt(schema.docSnapshots.id, cutoffId))
                    .run();
            }

            this.updatesSinceSnapshot = 0;
        } catch (error) {
            console.error(`[DbProvider] Error creating snapshot for ${this.docId}:`, error);
        }
    }

    getRevisions(): { id: number; createdAt: Date | null }[] {
        return this.db.select({
            id: schema.docSnapshots.id,
            createdAt: schema.docSnapshots.createdAt,
        }).from(schema.docSnapshots)
            .orderBy(desc(schema.docSnapshots.id))
            .all();
    }

    getRevisionState(revisionId: number): Uint8Array | null {
        const snapshot = this.db.select({stateData: schema.docSnapshots.stateData}).from(schema.docSnapshots)
            .where(eq(schema.docSnapshots.id, revisionId))
            .get();
        return snapshot ? (snapshot.stateData as Uint8Array) : null;
    }

    destroy(): void {
        this.doc.off('update', this.updateHandler);
        this.createSnapshot();
    }
}

export default class CollabDocument {
    private drive: Drive;
    private path: DrivePath;
    private doc!: Y.Doc;
    private provider!: DbProvider;
    private awareness!: awarenessProtocol.Awareness;
    private connections: Set<ServerWebSocket<any>> = new Set();
    private connectionClientIds: Map<ServerWebSocket<any>, Set<number>> = new Map();
    private closed: boolean = false;
    public dataDbPathId: string | null = null;

    constructor(drive: Drive, path: DrivePath) {
        this.drive = drive;
        this.path = path;

    }

    static async create(drive: Drive, mountId: string, docId: string): Promise<void> {
        await drive.touchFile(mountId, docId, 'data.db', 'application/x-sqlite3');
        await drive.createFolder(mountId, docId, 'media');
        await drive.createFolder(mountId, docId, 'chat');
    }

    public async init() {
        let dataDbPath = await this.drive.getChildByName(this.path.mountId, this.path.id, 'data.db');
        if (!dataDbPath) {
            await CollabDocument.create(this.drive, this.path.mountId, this.path.id);
            dataDbPath = await this.drive.getChildByName(this.path.mountId, this.path.id, 'data.db');
            if (!dataDbPath) {
                throw new Error(`Failed to create data.db in ${this.path.name}`);
            }
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
            if (origin && typeof origin === 'object' && 'readyState' in origin) {
                this.broadcastMessage(origin as ServerWebSocket<any>, message);
            } else {
                for (const conn of this.connections) {
                    if (conn.readyState === 1) conn.send(Buffer.from(message));
                }
            }
        });

        this.awareness.on('update', ({added, updated, removed}: {added: number[], updated: number[], removed: number[]}, origin: unknown) => {
            const changedClients = added.concat(updated, removed);
            if (changedClients.length === 0) return;
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
            encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients));
            const message = encoding.toUint8Array(encoder);
            for (const conn of this.connections) {
                if (conn !== origin && conn.readyState === 1) {
                    conn.send(Buffer.from(message));
                }
            }
        });

        return this;
    }

    public getRevisions(): { id: number; createdAt: Date | null }[] {
        return this.provider.getRevisions();
    }

    public getRevisionState(revisionId: number): Uint8Array | null {
        return this.provider.getRevisionState(revisionId);
    }

    public destruct() {
        this.closed = true;
        // destroy all connections
        for (const conn of this.connections) {
            conn.close();
            this.connections.delete(conn);
        }
        this.provider.destroy();
        this.awareness.destroy();
        this.doc.destroy();
    }

    public subscribe(_user: User, conn: ServerWebSocket<any>) {
        if (this.closed) {
            return;
        }
        this.connections.add(conn);
        this.sendSyncStep1(conn);
    }

    public unsubscribe(_user: User, conn: ServerWebSocket<any>) {
        if (this.closed) {
            return;
        }
        this.connections.delete(conn);

        const clientIds = this.connectionClientIds.get(conn);
        if (clientIds && clientIds.size > 0) {
            awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(clientIds), null);
        }
        this.connectionClientIds.delete(conn);

        for (const connection of this.connections) {
            if (connection.readyState > 1) { // CLOSING or CLOSED
                this.connections.delete(connection);
                const staleIds = this.connectionClientIds.get(connection);
                if (staleIds && staleIds.size > 0) {
                    awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(staleIds), null);
                }
                this.connectionClientIds.delete(connection);
            }
        }
        // check if this.connections is empty
        if (this.connections.size <= 0) {
            this.drive.closeCollabDocument(this.path.mountId, this.path.id);
        }
    }

    public handleMessage(conn: ServerWebSocket<any>, update: Uint8Array, canWrite: boolean) {
        if (this.closed) {
            return;
        }
        // Create a decoder from the message
        const decoder = decoding.createDecoder(update);
        const messageType = decoding.readVarUint(decoder);

        if (messageType === MESSAGE_SYNC) {
            // Check if the message is a read-only update
            const updateType = decoding.peekUint8(decoder);
            if (!canWrite && (updateType === 1 || updateType === 2)) {
                return;
            }

            // Create response encoder
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_SYNC);

            // Process sync message
            syncProtocol.readSyncMessage(
                decoder,
                encoder,
                this.doc,
                conn
            );

            // Only send a response if we have content beyond the message type
            if (encoding.length(encoder) > 1) {
                const responseMessage = encoding.toUint8Array(encoder);
                conn.send(new Buffer(responseMessage));
            }

            // No need to broadcast - updates trigger the doc's 'update' event which is handled separately
        } else if (messageType === MESSAGE_AWARENESS) {
            // Process awareness message
            const awarenessUpdate = decoding.readVarUint8Array(decoder);
            awarenessProtocol.applyAwarenessUpdate(
                this.awareness,
                awarenessUpdate,
                conn
            );

            // Track which clientIds belong to this connection
            try {
                const trackDecoder = decoding.createDecoder(awarenessUpdate);
                const len = decoding.readVarUint(trackDecoder);
                if (!this.connectionClientIds.has(conn)) {
                    this.connectionClientIds.set(conn, new Set());
                }
                const ids = this.connectionClientIds.get(conn)!;
                for (let i = 0; i < len; i++) {
                    ids.add(decoding.readVarUint(trackDecoder));
                }
            } catch {
                // ignore parsing errors
            }

            // Broadcast the awareness update to all other clients
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
            encoding.writeVarUint8Array(encoder, awarenessUpdate);
            this.broadcastMessage(
                conn,
                encoding.toUint8Array(encoder)
            );
        } else {
            console.warn(`Unknown message type: ${messageType}`);
        }
    }

    // Helper function to broadcast a message to all clients
    private broadcastMessage(originConn: ServerWebSocket<any>, message: Uint8Array) {
        if (this.closed) {
            return;
        }
        for (const conn of this.connections) {
            if (conn !== originConn && conn.readyState === 1) { // OPEN
                try {
                    conn.send(Buffer.from(message));
                } catch (err) {
                    console.error('Error sending message to client:', err);
                }
            }
        }
    }

// Helper function to send full document state to a client
    private sendSyncStep1(conn: ServerWebSocket<any>) {
        if (this.closed) {
            return;
        }
        try {
            // Create encoder for sync step 1 message
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            syncProtocol.writeSyncStep1(encoder, this.doc);
            const syncMessage = encoding.toUint8Array(encoder);

            // Send the message
            conn.send(Buffer.from(syncMessage));

            // Send awareness information if any exists
            const awarenessStates = this.awareness.getStates();
            if (awarenessStates.size > 0) {
                const awarenessEncoder = encoding.createEncoder();
                encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
                encoding.writeVarUint8Array(
                    awarenessEncoder,
                    awarenessProtocol.encodeAwarenessUpdate(
                        this.awareness,
                        Array.from(awarenessStates.keys())
                    )
                );

                const awarenessMessage = encoding.toUint8Array(awarenessEncoder);
                conn.send(Buffer.from(awarenessMessage));
            }
        } catch (err) {
            console.error('Error sending sync step 1:', err);
        }
    }
}