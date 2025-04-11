import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getDrive} from "../lib/drive/drive";
import {type User} from "better-auth/types";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import {type ServerWebSocket} from "bun";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// Define our data structure for WebSocket
type WsContext = {
    user?: User;
    session?: DocumentSession;
    canWrite?: boolean;
    lastActivity?: number;
    pingInterval?: NodeJS.Timeout;
}

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
            console.log(`[LoggingProvider] Document ${docId} updated, update size: ${update.length} bytes`);
            console.log(doc.toJSON());
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

// Define types for collaborative document sessions
interface DocumentSession {
    doc: Y.Doc;
    provider: LoggingProvider;
    awareness: awarenessProtocol.Awareness;
    connections: Set<ServerWebSocket<WsContext>>;
}

// Store document sessions in memory
const documentSessions = new Map<string, DocumentSession>();

// Helper to get or create a document session
async function getDocumentSession(pathId: string, user: User): Promise<DocumentSession> {
    if (documentSessions.has(pathId)) {
        return documentSessions.get(pathId)!;
    }

    // Create new session
    const doc = new Y.Doc();
    const provider = new LoggingProvider(doc, pathId);
    const awareness = new awarenessProtocol.Awareness(doc);

    const session: DocumentSession = {
        doc,
        provider,
        awareness,
        connections: new Set()
    };

    documentSessions.set(pathId, session);
    return session;
}

// Clean up sessions that haven't been accessed for a while
function cleanupSessions() {
    for (const [pathId, session] of documentSessions.entries()) {
        if (session.connections.size === 0) {
            console.log(`Cleaning up inactive session for ${pathId}`);
            session.provider.destroy();
            documentSessions.delete(pathId);
        }
    }
}

// Helper function to broadcast a message to all clients
function broadcastMessage(session: DocumentSession, originConn: ServerWebSocket<WsContext>, message: Uint8Array) {
    for (const conn of session.connections) {
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
function sendSyncStep1(session: DocumentSession, conn: ServerWebSocket<WsContext>) {
    try {
        // Create encoder for sync step 1 message
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, session.doc);
        const syncMessage = encoding.toUint8Array(encoder);

        // Send the message
        conn.send(Buffer.from(syncMessage));
        console.log('Sent initial document state, size:', syncMessage.length);

        // Send awareness information if any exists
        const awarenessStates = session.awareness.getStates();
        if (awarenessStates.size > 0) {
            const awarenessEncoder = encoding.createEncoder();
            encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
            encoding.writeVarUint8Array(
                awarenessEncoder,
                awarenessProtocol.encodeAwarenessUpdate(
                    session.awareness,
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

// Set up a cleanup interval
setInterval(cleanupSessions, 5 * 60 * 1000); // Every 5 minutes

export const collabRouter = new Elysia({
    name: "collab",
    websocket: {
        perMessageDeflate: true,
    }
})
    .use(betterAuth)

    // Endpoint to check if user has access to document
    .get("/collab/access/:userId/:pathId", async ({params, user}: { params: { pathId: string }, user: User }) => {
        const drive = await getDrive(user);
        const canRead = await drive.canRead(params.pathId, user);
        const canWrite = await drive.canWrite(params.pathId, user);
        return {canRead, canWrite};
    }, {
        auth: true,
        params: t.Object({
            pathId: t.String(),
        })
    })

    // WebSocket endpoint for collaborative editing
    .ws("/ws/collab/:userId/:pathId", {
        auth: true,
        params: t.Object({
            userId: t.String(),
            pathId: t.String(),
        }),

        async open(ws) {
            console.log('WebSocket connection opened');

            // Get user from ws.data (provided by betterAuth)
            // @ts-ignore
            const user = ws.data?.user;
            if (!user) {
                ws.close(1008, "Authentication failed");
                return;
            }

            // For this proof-of-concept, we're using the pathId directly
            const pathId = ws.data.params.pathId;
            console.log(`User ${user.id} connecting to document ${pathId}`);

            // Get document session
            const session = await getDocumentSession(pathId, user);
            session.connections.add(ws as unknown as ServerWebSocket<WsContext>);

            // Send initial document state and awareness information
            sendSyncStep1(session, ws as unknown as ServerWebSocket<WsContext>);

            console.log(`User ${user.id} connected to document ${pathId}`);

            // Keep the connection alive with ping/pong
            const pingInterval = setInterval(() => {
                if (ws.readyState === 1) { // OPEN
                    try {
                        ws.ping();
                    } catch (err) {
                        clearInterval(pingInterval);
                        session.connections.delete(ws as unknown as ServerWebSocket<WsContext>);
                        console.log(`Ping failed, closing connection for user ${user.id}`);
                    }
                } else {
                    clearInterval(pingInterval);
                }
            }, 30000);
        },

        async message(ws, message) {
            // @ts-ignore
            const user = ws.data?.user;
            if (!user) {
                ws.close(1008, "Authentication failed");
                return;
            }

            try {
                const pathId = ws.data.params.pathId;
                const session = await getDocumentSession(pathId, user);

                // Handle text-based protocol messages (like ping/pong)
                if (typeof message === 'string') {
                    if (message === 'ping') {
                        ws.send('pong');
                    }
                    return;
                }

                console.log(session.doc.toJSON());

                // Convert message to Uint8Array if needed
                let update: Uint8Array;
                if (message instanceof Uint8Array) {
                    update = message;
                } else {
                    update = new Uint8Array(message as Buffer);
                }

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
                        session.doc,
                        ws as unknown as ServerWebSocket<WsContext>
                    );

                    // Only send a response if we have content beyond the message type
                    if (encoding.length(encoder) > 1) {
                        const responseMessage = encoding.toUint8Array(encoder);
                        (ws as unknown as ServerWebSocket<WsContext>).send(new Buffer(responseMessage));
                    }

                    // No need to broadcast - updates trigger the doc's 'update' event which is handled separately
                } else if (messageType === MESSAGE_AWARENESS) {
                    // Process awareness message
                    const awarenessUpdate = decoding.readVarUint8Array(decoder);
                    awarenessProtocol.applyAwarenessUpdate(
                        session.awareness,
                        awarenessUpdate,
                        ws as unknown as ServerWebSocket<WsContext>
                    );

                    // Broadcast the awareness update to all other clients
                    const encoder = encoding.createEncoder();
                    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
                    encoding.writeVarUint8Array(encoder, awarenessUpdate);
                    broadcastMessage(
                        session,
                        ws as unknown as ServerWebSocket<WsContext>,
                        encoding.toUint8Array(encoder)
                    );
                } else {
                    console.warn(`Unknown message type: ${messageType}`);
                }
            } catch (err) {
                console.error('Error processing message:', err);
            }
        },

        close(ws) {
            if (!ws.data) return;

            try {
                // @ts-ignore
                const user = ws.data.user;
                if (user) {
                    const pathId = ws.data.params.pathId;
                    console.log(`User ${user.id} disconnected from document ${pathId}`);

                    // Get the document session
                    if (documentSessions.has(pathId)) {
                        const session = documentSessions.get(pathId)!;

                        // Remove connection from the session
                        session.connections.delete(ws as unknown as ServerWebSocket<WsContext>);
                        console.log(`Remaining connections for document ${pathId}: ${session.connections.size}`);
                    }
                }
            } catch (err) {
                console.error('Error handling WebSocket close:', err);
            }
        }
    });
