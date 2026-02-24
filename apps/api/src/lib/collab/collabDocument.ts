import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import {type ServerWebSocket} from "bun";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type {DrivePath} from "@workspace/lib/types/drive";
import type {Drive} from "../drive";
import type {ManagedDatabase} from "../core/managed-database";
import {COLLAB_DB_CONFIG} from "./db-config";
import * as schema from "./schema.ts";
import type {User} from "better-auth/types";
import type {BunSQLiteDatabase} from "drizzle-orm/bun-sqlite";

// Define message types (matching y-websocket protocol)
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

// A simple provider that logs operations instead of persisting to database
class LoggingProvider {
    private docId: string;

    constructor(doc: Y.Doc, docId: string) {
        this.docId = docId;
        console.log(`[LoggingProvider] Created for document: ${docId}`);

        // Listen for document updates

        // updateV2 ?
        doc.on('update', (_update: Uint8Array) => {
            // console.log(`[LoggingProvider] Document ${docId} updated, update size: ${update.length} bytes`);
            // console.log(doc.toJSON());
        });
    }

    // Method to store an update (would save to database in real implementation)
    storeUpdate(update: Uint8Array): void {
        console.log(`[LoggingProvider] Storing update for document ${this.docId}, size: ${update.length} bytes`);
        // In a real implementation, save update to database
    }

    // Cleanup resources
    destroy(): void {
        console.log(`[LoggingProvider] Destroying provider for document ${this.docId}`);
        // In a real implementation, close database connection
    }
}

class DbProvider {
    private db: BunSQLiteDatabase<typeof schema>;
    private managedDb: ManagedDatabase<typeof schema>;
    private doc: Y.Doc;
    private docId: string;

    constructor(doc: Y.Doc, docId: string, managedDb: ManagedDatabase<typeof schema>) {
        this.managedDb = managedDb;
        this.db = managedDb.db;
        this.doc = doc;
        this.docId = docId;

        console.log(`[DbProvider] Created for document: ${docId}`);

        // apply all changes from database to document
        this.db.select().from(schema.docUpdates).then((updates) => {
            for(const update of updates) {
                // Apply each update to the document
                const data = update.updateData as Uint8Array;
                console.log(`[DbProvider] Applying update for document ${this.docId}, size: ${data.length} bytes`);
                Y.applyUpdate(doc, data);
            }
        }).catch((error) => {
            console.error(`[DbProvider] Error fetching updates for document ${this.docId}:`, error);
        });

        // updateV2 ?
        doc.on('updateV2', (_update: Uint8Array) => {
            // this.storeUpdate(update);
        });
    }

    // Method to store an update (would save to database in real implementation)
    storeUpdate(update: Uint8Array): void {
        console.log(`[DbProvider] Storing update for document ${this.docId}, size: ${update.length} bytes`);
        try {
            this.db.insert(schema.docUpdates).values({
                updateData: Buffer.from(update)
            }).run();
            this.managedDb.markDirty();
            console.log(`[DbProvider] Successfully stored update for document ${this.docId}`);
        } catch (error) {
            console.error(`[DbProvider] Error storing update for document ${this.docId}:`, error);
        }
    }

    // Cleanup resources
    destroy(): void {
        console.log(`[DbProvider] Destroying provider for document ${this.docId}`);
        const update = Y.encodeStateAsUpdate(this.doc);
        this.db.delete(schema.docUpdates).run();
        this.storeUpdate(update);
    }
}

export default class CollabDocument {
    private drive: Drive;
    private path: DrivePath;
    private doc!: Y.Doc;
    private provider!: LoggingProvider | DbProvider;
    private awareness!: awarenessProtocol.Awareness;
    private connections: Set<ServerWebSocket<any>> = new Set();
    private closed: boolean = false;

    constructor(drive: Drive, path: DrivePath) {
        this.drive = drive;
        this.path = path;

        console.log(`[CollabDocument] Created for path: ${path.name}`);
    }

    static async create(drive: Drive, mountId: string, docId: string): Promise<void> {
        await drive.touchFile(mountId, docId, 'data.db', 'application/x-sqlite3');
        await drive.createFolder(mountId, docId, 'media');
    }

    public async init() {
        console.log(`[CollabDocument] init for path: ${this.path.name}`);

        let dataDbPath = await this.drive.getChildByName(this.path.mountId, this.path.id, 'data.db');
        if (!dataDbPath) {
            await CollabDocument.create(this.drive, this.path.mountId, this.path.id);
            dataDbPath = await this.drive.getChildByName(this.path.mountId, this.path.id, 'data.db');
            if (!dataDbPath) {
                throw new Error(`Failed to create data.db in ${this.path.name}`);
            }
        }

        const managedDb = await this.drive.openDatabase(this.path.mountId, COLLAB_DB_CONFIG, dataDbPath.id);

        this.doc = new Y.Doc();
        this.doc.gc = true;
        this.provider = new DbProvider(this.doc, this.path.name, managedDb);
        this.awareness = new awarenessProtocol.Awareness(this.doc);

        return this;
    }

    public destruct() {
        this.closed = true;
        // destroy all connections
        for(const conn of this.connections) {
            conn.close();
            this.connections.delete(conn);
        }
        this.provider.destroy();
        this.awareness.destroy();
        this.doc.destroy();
    }

    public subscribe(user: User, conn: ServerWebSocket<any>) {
        if (this.closed) {
            return;
        }
        this.connections.add(conn);
        this.sendSyncStep1(conn);
        console.log(`User ${user.id} connected to document ${this.path.name}`);
    }

    public unsubscribe(user: User, conn: ServerWebSocket<any>) {
        if (this.closed) {
            return;
        }
        this.connections.delete(conn);
        console.log(`User ${user.id} disconnected from document ${this.path.name}`);
        for(const connection of this.connections) {
            if (connection.readyState > 1) { // CLOSING or CLOSED
                this.connections.delete(connection);
            }
        }
        console.log(`Remaining connections: ${this.connections.size}`);
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
            console.log('Sent initial document state, size:', syncMessage.length);

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
                console.log('Sent awareness states, size:', awarenessMessage.length);
            }
        } catch (err) {
            console.error('Error sending sync step 1:', err);
        }
    }
}