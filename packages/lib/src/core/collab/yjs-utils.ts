import * as Y from 'yjs';

// Recursively wraps a plain JSON value into Y.Map / Y.Array. Primitives pass
// through. Used as the default value converter for restoreYjsDoc — apps whose
// Y.Map values are scalars / JSON strings can pass `(v) => v` to skip wrapping.
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

// Replaces a Y.Doc's top-level Y.Map / Y.Array contents with the contents of a
// snapshot update, inside a single transaction. The transaction's update fires
// through the doc's normal 'update' event so connected clients converge through
// the existing Yjs broadcast path — no reconnect, no merge fight.
//
// Y.XmlFragment (Tiptap docs) is NOT supported — its items round-trip through
// `toJSON()` as XML strings rather than live Y types, which would corrupt the
// fragment on push. Callers gate XmlFragment containers out before reaching here.
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
