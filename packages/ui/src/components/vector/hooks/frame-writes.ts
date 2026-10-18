// The editor's frame ops over a canvas Y.Doc: the fractional index arithmetic, the delete/duplicate
// passes that must also move the frame's ELEMENTS, over the shared writer (write-vector.ts), and the
// meta keys that size them. Plain functions over the doc, the way element-writes.ts is, so the hook
// stays the thin React surface.

import {
    elementsInFrame,
    FRAME_FIELDS,
    generateKeyBetween,
    isValidFractionalIndex,
    newFrameId,
    readVectorFromDoc,
    type VectorFrame,
    type VectorMeta,
    writeFrameInDoc,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import { duplicateElementsInDoc } from './element-writes';

function strField(map: Y.Map<unknown>, key: string): string {
    const value = map.get(key);
    return typeof value === 'string' ? value : '';
}

// The frames in stored order, as {id, index} pairs — the index arithmetic every op below does. Skips
// malformed entries so a corrupt peer write cannot make generateKeyBetween throw (read-vector heals
// them on read).
function frameOrder(framesMap: Y.Map<unknown>): { id: string; index: string }[] {
    const out: { id: string; index: string }[] = [];
    for (const value of framesMap.values()) {
        if (!(value instanceof Y.Map)) continue;
        const id = value.get('id');
        const index = value.get('index');
        if (typeof id !== 'string' || typeof index !== 'string') continue;
        if (!isValidFractionalIndex(index, undefined, undefined)) continue;
        out.push({ id, index });
    }
    return out.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
}

// The key that lands a frame directly after `afterId` — at the front for null, at the end when it is
// unknown. `excludeId` drops the frame being moved from the order it is placed into.
function keyAfter(framesMap: Y.Map<unknown>, afterId: string | null, excludeId?: string): string {
    const order = frameOrder(framesMap).filter((f) => f.id !== excludeId);
    if (afterId === null) return generateKeyBetween(null, order[0]?.index ?? null);
    const at = order.findIndex((f) => f.id === afterId);
    if (at === -1) return generateKeyBetween(order[order.length - 1]?.index ?? null, null);
    return generateKeyBetween(order[at].index, order[at + 1]?.index ?? null);
}

export function addFrameInDoc(doc: Y.Doc, afterId: string | null): string {
    const id = newFrameId();
    writeFrameInDoc(doc, { id, index: keyAfter(doc.getMap('frames'), afterId) });
    return id;
}

// The frame AND everything homed to it, in one transact — one undo step, and never an element left
// pointing at a frame that is gone (the reader would silently re-home it to the first frame).
export function deleteFrameInDoc(doc: Y.Doc, id: string): void {
    doc.transact(() => {
        const elementsMap = doc.getMap('elements');
        for (const el of elementsInFrame(readVectorFromDoc(doc).elements, id)) elementsMap.delete(el.id);
        doc.getMap('frames').delete(id);
    });
}

// A copy of the frame directly after it, holding copies of its elements. Element cloning goes through
// duplicateElementsInDoc, so arrow bindings remap across the copied set exactly as ⌘D does. Returns ''
// when the frame is gone (a peer deleted it mid-click) rather than writing a blank copy of nothing.
export function duplicateFrameInDoc(doc: Y.Doc, id: string): string {
    const framesMap = doc.getMap('frames');
    const source = framesMap.get(id);
    if (!(source instanceof Y.Map)) return '';
    const copyId = newFrameId();
    doc.transact(() => {
        const name = strField(source, 'name');
        const background = strField(source, 'background');
        writeFrameInDoc(doc, { id: copyId, index: keyAfter(framesMap, id), name, background });

        const sourceIds = elementsInFrame(readVectorFromDoc(doc).elements, id).map((el) => el.id);
        // Frame-relative coordinates, so the copies keep their positions inside the new frame.
        const cloneIds = duplicateElementsInDoc(doc, sourceIds, 0, 0);
        const elementsMap = doc.getMap('elements');
        for (const cloneId of cloneIds) {
            const map = elementsMap.get(cloneId);
            if (map instanceof Y.Map) map.set('frameId', copyId);
        }
    });
    return copyId;
}

// Reorder by rewriting ONE key. Never delete-and-recreate the Y.Map: that discards the frame's CRDT
// identity, so a peer renaming it (or changing its background) concurrently with the move loses the
// edit outright — the classic "the reorder ate my rename" merge bug.
export function moveFrameInDoc(doc: Y.Doc, id: string, afterId: string | null): void {
    doc.transact(() => {
        const framesMap = doc.getMap('frames');
        const map = framesMap.get(id);
        if (!(map instanceof Y.Map)) return;
        // The key is computed against the order WITHOUT this frame, so moving one place forward is not
        // a no-op — but the exclusion is a filter, never a deletion.
        map.set('index', keyAfter(framesMap, afterId, id));
    });
}

export function updateFramesInDoc(doc: Y.Doc, patches: { id: string; fields: Partial<VectorFrame> }[]): void {
    doc.transact(() => {
        const framesMap = doc.getMap('frames');
        for (const { id, fields } of patches) {
            const map = framesMap.get(id);
            if (!(map instanceof Y.Map)) continue;
            for (const [key, value] of Object.entries(fields)) {
                if (key === 'id' || value === undefined) continue;
                if (FRAME_FIELDS.includes(key)) map.set(key, value);
            }
        }
    });
}

export function updateMetaInDoc(doc: Y.Doc, fields: Partial<VectorMeta>): void {
    doc.transact(() => {
        const metaMap = doc.getMap('meta');
        for (const [key, value] of Object.entries(fields)) {
            if (value !== undefined) metaMap.set(key, value);
        }
    });
}
