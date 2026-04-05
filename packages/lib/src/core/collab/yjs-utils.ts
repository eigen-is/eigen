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
 * 2. Copies every shared type from the temp doc into the target doc inside a
 *    single transaction.
 * 3. Destroys the temp doc.
 *
 * @param mapValueConverter — called on each Map entry value before inserting it
 *   into the target doc.  Defaults to `jsonToYType` (deep conversion).  Pass
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
            const localType = yjsDoc.get(key);
            if (localType instanceof Y.Map) {
                const json = tempDoc.getMap(key).toJSON();
                for (const k of [...localType.keys()]) localType.delete(k);
                for (const [k, v] of Object.entries(json)) {
                    localType.set(k, mapValueConverter(v));
                }
            } else if (localType instanceof Y.Array) {
                const json = tempDoc.getArray(key).toJSON();
                localType.delete(0, localType.length);
                localType.push(json);
            }
        }
    });
    tempDoc.destroy();
}
