import * as Y from 'yjs';

/**
 * Recursively converts a plain JSON value into the corresponding Yjs shared type.
 * Arrays become Y.Array, objects become Y.Map, and primitives pass through.
 */
export function jsonToYType(value: unknown): unknown {
    if (Array.isArray(value)) {
        const arr = new Y.Array();
        arr.push(value.map(jsonToYType));
        return arr;
    }
    if (value !== null && typeof value === 'object') {
        const map = new Y.Map();
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            map.set(k, jsonToYType(v));
        }
        return map;
    }
    return value;
}

/**
 * Restores a Y.Doc from a serialised state snapshot.
 *
 * 1. Creates a temporary Y.Doc and applies the state update to it.
 * 2. For every top-level shared type in either doc, clears the live entry and
 *    re-inserts the snapshot's content inside a single transaction. The
 *    transaction's update flows through the doc's normal 'update' event, so
 *    connected clients converge through the existing Yjs broadcast path.
 * 3. Destroys the temp doc.
 *
 * @param mapValueConverter — called on each Map entry value before inserting it
 *   into the target doc. Defaults to `jsonToYType` (deep conversion). Pass
 *   `(v) => v` if your values are already plain scalars / JSON strings.
 */
export function restoreYjsDoc(
    yjsDoc: Y.Doc,
    state: Uint8Array,
    mapValueConverter: (v: unknown) => unknown = jsonToYType,
): void {
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, state);

    const allKeys = new Set([...yjsDoc.share.keys(), ...tempDoc.share.keys()]);

    yjsDoc.transact(() => {
        for (const key of allKeys) {
            // Y.applyUpdate alone registers shared types as AbstractType — the
            // base class — not Y.Map / Y.Array. `instanceof` against the
            // concrete types fails for both sides whenever the doc state was
            // hydrated purely from an update stream (which is the server-side
            // case after `loadYjsState`). Discriminate via the internal `_start`
            // pointer instead: Y.Array uses a linked list (`_start` set),
            // Y.Map uses `_map` exclusively (`_start` is null). Then call
            // `getArray` / `getMap` on the doc — Yjs converts the AbstractType
            // entry to the concrete subclass in place, preserving the data.
            const ref = (tempDoc.share.get(key) ?? yjsDoc.share.get(key)) as
                | undefined
                | (Y.AbstractType<unknown> & { _start: unknown });
            if (!ref) continue;
            const isArray = ref._start != null;

            if (isArray) {
                const liveArr = yjsDoc.getArray(key);
                const tempArr = tempDoc.share.get(key) ? tempDoc.getArray(key).toJSON() : [];
                liveArr.delete(0, liveArr.length);
                liveArr.push(tempArr);
            } else {
                const liveMap = yjsDoc.getMap(key);
                const tempMap = tempDoc.share.get(key) ? tempDoc.getMap(key).toJSON() : {};
                for (const k of [...liveMap.keys()]) liveMap.delete(k);
                for (const [k, v] of Object.entries(tempMap)) {
                    liveMap.set(k, mapValueConverter(v));
                }
            }
        }
    });
    tempDoc.destroy();
}
