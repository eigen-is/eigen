// Helpers over a collaborative app's Y.Doc. A version restore rebuilds the live doc's roots from a snapshot in one
// transaction, so connected peers converge through the normal update stream. Typed reads cover the item maps and id
// arrays that apps such as Slides and Stickies keep, and the cards a Stickies board shows. Callers include the
// server's collab document, which restores through it, and the Stickies board in the browser and on the server.

import type { YjsRootKind } from '@workspace/lib/types/drive';
import * as Y from 'yjs';

// Replaces a Y.Doc's declared roots with the contents of a snapshot update, in one transaction. Its update goes out
// through the doc's normal 'update' event, so connected clients converge through the usual Yjs broadcast. No client
// reconnects, and no app needs a handler of its own.
//
// It handles every Y type an Eigen container uses, nested to any depth: Y.Map, Y.Array, Y.Text and Tiptap's
// Y.XmlFragment. It rebuilds each value on the live doc rather than moving it, because a Y item belongs to the doc it
// was made in.
//
// `roots` names each top-level root and its kind, as EIGEN_DOC_TYPE_INFO declares them. Both docs' roots get their
// kind before the walk, because Y.applyUpdate gives a root no concrete type and an `instanceof` check would get it
// wrong.
export function restoreYjsDoc(yjsDoc: Y.Doc, state: Uint8Array, roots: Record<string, YjsRootKind>): void {
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, state);

    for (const [name, kind] of Object.entries(roots)) {
        forceTypeRoot(yjsDoc, name, kind);
        forceTypeRoot(tempDoc, name, kind);
    }

    yjsDoc.transact(() => {
        for (const name of Object.keys(roots)) {
            const live = yjsDoc.share.get(name);
            const source = tempDoc.share.get(name);
            if (!live || !source) continue;
            replaceYType(live, source);
        }
    });
    tempDoc.destroy();
}

function forceTypeRoot(doc: Y.Doc, name: string, kind: YjsRootKind): void {
    switch (kind) {
        case 'map':
            doc.getMap(name);
            return;
        case 'array':
            doc.getArray(name);
            return;
        case 'text':
            doc.getText(name);
            return;
        case 'xmlfragment':
            doc.getXmlFragment(name);
            return;
        default: {
            const _exhaustive: never = kind;
            throw new Error(`forceTypeRoot: unhandled root kind ${_exhaustive}`);
        }
    }
}

// Yjs types AbstractType<TEvent> so that `Y.AbstractType<unknown>` accepts no Y.Map<T> or Y.XmlFragment. The walker
// tells the types apart with `instanceof` at runtime, so the type parameter tells it nothing, and it takes `any`.
// biome-ignore lint/suspicious/noExplicitAny: see comment above
type AnyYType = Y.AbstractType<any>;

// What y-tiptap writes as a node's attribute: a JSON value, which Yjs keeps as it is.
type XmlAttributes = Record<string, object | string | number | boolean | null>;

// Clears `live` and fills it again with a deep clone of `source`. Both are of the same Y type, because forceTypeRoot
// gave both roots their kind first.
function replaceYType(live: AnyYType, source: AnyYType): void {
    if (live instanceof Y.XmlFragment && source instanceof Y.XmlFragment) {
        if (live.length) live.delete(0, live.length);
        const children = cloneXmlChildren(source);
        if (children.length) live.insert(0, children);
        return;
    }
    if (live instanceof Y.Map && source instanceof Y.Map) {
        for (const k of [...live.keys()]) live.delete(k);
        for (const [k, v] of source.entries()) {
            live.set(k, v instanceof Y.AbstractType ? cloneYType(v) : v);
        }
        return;
    }
    if (live instanceof Y.Array && source instanceof Y.Array) {
        if (live.length) live.delete(0, live.length);
        const items = source.toArray().map((v) => (v instanceof Y.AbstractType ? cloneYType(v) : v));
        if (items.length) live.push(items);
        return;
    }
    if (live instanceof Y.Text && source instanceof Y.Text) {
        if (live.length) live.delete(0, live.length);
        live.applyDelta(source.toDelta());
        return;
    }
    throw new Error(
        `restoreYjsDoc: root-type mismatch (live=${live.constructor.name}, source=${source.constructor.name})`,
    );
}

// A fresh copy that belongs to no doc yet. Yjs takes it into the doc once the caller inserts it into a live value.
// Y.XmlText extends Y.Text and Y.XmlElement extends Y.XmlFragment, so each subclass is checked before its parent.
function cloneYType(source: AnyYType): AnyYType {
    if (source instanceof Y.XmlElement) {
        const c = new Y.XmlElement<XmlAttributes>(source.nodeName);
        for (const [k, v] of Object.entries(source.getAttributes())) {
            c.setAttribute(k, v instanceof Y.AbstractType ? cloneYType(v) : v);
        }
        const children = cloneXmlChildren(source);
        if (children.length) c.insert(0, children);
        return c;
    }
    if (source instanceof Y.XmlText) {
        const c = new Y.XmlText();
        c.applyDelta(source.toDelta());
        return c;
    }
    if (source instanceof Y.XmlFragment) {
        const c = new Y.XmlFragment();
        const children = cloneXmlChildren(source);
        if (children.length) c.insert(0, children);
        return c;
    }
    if (source instanceof Y.Text) {
        const c = new Y.Text();
        c.applyDelta(source.toDelta());
        return c;
    }
    if (source instanceof Y.Map) {
        const c = new Y.Map();
        for (const [k, v] of source.entries()) {
            c.set(k, v instanceof Y.AbstractType ? cloneYType(v) : v);
        }
        return c;
    }
    if (source instanceof Y.Array) {
        const c = new Y.Array();
        const items = source.toArray().map((v) => (v instanceof Y.AbstractType ? cloneYType(v) : v));
        if (items.length) c.push(items);
        return c;
    }
    throw new Error(`restoreYjsDoc: cannot clone ${source.constructor.name}`);
}

// An XML fragment or element only takes XML elements and XML text as children, and cloneYType returns any Y type,
// so this checks each cloned child. No Eigen app uses Y.XmlHook.
function cloneXmlChildren(source: Y.XmlFragment | Y.XmlElement): (Y.XmlElement | Y.XmlText)[] {
    return source.toArray().map((child) => {
        const clone = cloneYType(child);
        if (clone instanceof Y.XmlElement || clone instanceof Y.XmlText) return clone;
        throw new Error(`restoreYjsDoc: XML child clone produced ${clone.constructor.name}`);
    });
}

// The root needs no check: doc.getMap gives a root that Y.applyUpdate left untyped its kind in place. Its entries
// stay unknown, because a peer can write a scalar where a map belongs, so every reader checks for a Y.Map.
export function getItemMapRoot(doc: Y.Doc, name: string): Y.Map<unknown> {
    return doc.getMap<unknown>(name);
}

export function getIdArrayRoot(doc: Y.Doc, name: string): Y.Array<string> {
    return doc.getArray<string>(name);
}

export function getIdArray(map: unknown, field: string): Y.Array<string> | undefined {
    if (!(map instanceof Y.Map)) return undefined;
    const value = map.get(field);
    return value instanceof Y.Array ? value : undefined;
}

// The cards a stickies board shows: an id a column lists that the tasks map holds as a card. A card on no column is off
// the board, so its comment thread is no longer in use.
export function boardCardIds(doc: Y.Doc): Set<string> {
    const tasks = getItemMapRoot(doc, 'tasks');
    const ids = new Set<string>();
    for (const column of getItemMapRoot(doc, 'columns').values()) {
        for (const id of getIdArray(column, 'taskIds')?.toArray() ?? []) {
            if (tasks.get(id) instanceof Y.Map) ids.add(id);
        }
    }
    return ids;
}
