import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import {type ServerWebSocket} from "bun";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { DrivePath } from "../../types/drive";
import type Drive from "../drive/drive";
import {user} from "../../../auth-schema.ts";

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
        doc.on('update', (update: Uint8Array) => {
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

export default class CollabDocument {
    private drive: Drive;
    private path: DrivePath;
    private doc!: Y.Doc;
    private provider!: LoggingProvider;
    private awareness!: awarenessProtocol.Awareness;
    private connections: Set<ServerWebSocket<any>> =  new Set();

    constructor(drive: Drive, path: DrivePath) {
        this.drive = drive;
        this.path = path;
    }

    public async init() {
        this.doc = new Y.Doc();
        this.provider = new LoggingProvider(this.doc, this.path.name);
        this.awareness = new awarenessProtocol.Awareness(this.doc);

        return this;
    }

    public destruct() {
        this.provider.destroy();
    }

    public subscribe(conn: ServerWebSocket<any>) {
        this.connections.add(conn);
        this.sendSyncStep1(conn);
        console.log(`User ${user.id} connected to document ${this.path.name}`);
    }

    public unsubscribe(conn: ServerWebSocket<any>) {
        this.connections.delete(conn);
        console.log(`User ${user.id} disconnected from document ${this.path.name}`);
        this.connections.forEach((connection) => {
            if (connection.readyState > 1) { // CLOSING or CLOSED
                this.connections.delete(connection);
            }
        });
        // check if this.connections is empty
        if (this.connections.size === 0) {
            this.drive.closeCollabDocument(this.path.id);
        }
    }

    public handleMessage(conn: ServerWebSocket<any>, update: Uint8Array) {
        // Create a decoder from the message
        const decoder = decoding.createDecoder(update);
        const messageType = decoding.readVarUint(decoder);

        if (messageType === MESSAGE_SYNC) {
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