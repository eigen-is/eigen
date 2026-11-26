// The body of the collab state route: a document's stored Yjs updates in order, each behind its length. The server
// writes it from the rows of a document's data.db, and a reader who gets no socket applies it to the Y.Doc their
// editor shows. Applying a newer body on top of an older one brings that document up to date.

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';

// One copy of each update into a buffer of the body's size, since a body can be the whole of a large document.
export function encodeCollabState(updates: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const parts = updates.flatMap((update) => {
        const length = encoding.createEncoder();
        encoding.writeVarUint(length, update.byteLength);
        return [encoding.toUint8Array(length), update];
    });
    const body = new Uint8Array(parts.reduce((bytes, part) => bytes + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        body.set(part, offset);
        offset += part.byteLength;
    }
    return body;
}

export function applyCollabState(doc: Y.Doc, body: Uint8Array, origin: unknown): void {
    const decoder = decoding.createDecoder(body);
    while (decoding.hasContent(decoder)) Y.applyUpdate(doc, decoding.readVarUint8Array(decoder), origin);
}
