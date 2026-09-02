import type { YjsRootKind } from '@workspace/lib/types/drive';
import * as Y from 'yjs';

// Replaces a Y.Doc's declared root types with the contents of a snapshot
// update, inside a single transaction. The transaction's update fires through
// the doc's normal 'update' event so connected clients converge through the
// existing Yjs broadcast — no reconnect, no merge fight, no per-app handler.
//
// Works for every Y subtype an Eigen container actually uses: Y.Map, Y.Array,
// Y.Text, Y.XmlFragment (Tiptap), with arbitrary nesting. The walker rebuilds
// Y instances on the live doc rather than transplanting — Y items have
// identity tied to their source doc and can't be moved between docs.
//
// `roots` is the schema: which top-level names exist and what kind they are.
// Lives in EIGEN_DOC_TYPE_INFO. Used to force-type both docs' shared entries
// before the walk — Y.applyUpdate hydrates roots as AbstractType, so
// `instanceof` checks would otherwise misclassify them.
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

// Yjs's AbstractType<TEvent> is invariant in TEvent (it appears in both
// covariant and contravariant positions through internal EventHandler<TEvent>),
// so `Y.AbstractType<unknown>` won't accept `Y.Map<T>` / `Y.XmlFragment` / etc.
// We discriminate at runtime via `instanceof` regardless — the static T param
// is uninteresting here. Hence `<any>` at the walker boundary.
// biome-ignore lint/suspicious/noExplicitAny: see comment above
type AnyYType = Y.AbstractType<any>;

// In-place replace: clear `live`'s contents and rebuild from `source` by deep
// cloning. Live and source must be the same concrete subtype — guaranteed by
// forceTypeRoot pairing them at the call site.
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

// Build a fresh Y instance owned by no doc yet — caller inserts it into a live
// container, at which point Yjs integrates it. Order matters: Y.XmlText
// extends Y.Text in yjs, and Y.XmlElement extends Y.XmlFragment, so the more
// specific subclass must be checked first.
function cloneYType(source: AnyYType): AnyYType {
    if (source instanceof Y.XmlElement) {
        const c = new Y.XmlElement(source.nodeName);
        for (const [k, v] of Object.entries(source.getAttributes())) c.setAttribute(k, String(v));
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

// XmlFragment.insert() / XmlElement.insert() only accept (XmlElement | XmlText)
// — so children are cloned through a typed helper rather than the generic
// cloneYType (which returns AnyYType). Y.XmlHook is unused in Eigen apps.
function cloneXmlChildren(source: Y.XmlFragment | Y.XmlElement): (Y.XmlElement | Y.XmlText)[] {
    return source.toArray().map((child) => {
        const clone = cloneYType(child);
        if (clone instanceof Y.XmlElement || clone instanceof Y.XmlText) return clone;
        throw new Error(`restoreYjsDoc: XML child clone produced ${clone.constructor.name}`);
    });
}

// No runtime guard on roots: doc.get upgrades an AbstractType root (post-applyUpdate) in place.
export function getItemMapRoot(doc: Y.Doc, name: string): Y.Map<Y.Map<unknown>> {
    return doc.getMap<Y.Map<unknown>>(name);
}

export function getIdArrayRoot(doc: Y.Doc, name: string): Y.Array<string> {
    return doc.getArray<string>(name);
}

export function getIdArray(map: Y.Map<unknown>, field: string): Y.Array<string> | undefined {
    const value = map.get(field);
    return value instanceof Y.Array ? value : undefined;
}
