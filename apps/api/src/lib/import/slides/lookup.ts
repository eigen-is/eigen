import { type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlElements } from '../../core/xml';

// Every lookup the reader makes into an element goes through here. An element of a layout, master, theme or the
// presentation is looked into again for every slide, shape, paragraph and run that inherits it, and among its children
// a file can put any number of junk elements: each element's children are scanned once, whatever is looked up later.
// One of a few children is scanned each time instead, which costs no more than the index and keeps no memory.
const SCANNED_BELOW = 16;

// A value derived from an element once for each key.
export function cachedBy<K, V>(): (element: XmlElement, key: K, derive: () => V) => V {
    const cache = new WeakMap<XmlElement, Map<K, { value: V }>>();
    return (element, key, derive) => {
        let values = cache.get(element);
        if (!values) {
            values = new Map();
            cache.set(element, values);
        }
        const known = values.get(key);
        if (known) return known.value;
        const value = derive();
        values.set(key, { value });
        return value;
    };
}

// The first child of each name.
const indexes = new WeakMap<XmlElement, Map<string, XmlElement>>();

// The first child of this name, as xmlChild finds it.
export function childOf(element: XmlElement, ns: string, local: string): XmlElement | undefined {
    if (element.children.length < SCANNED_BELOW) return xmlChild(element, ns, local);
    let index = indexes.get(element);
    if (!index) {
        index = new Map();
        for (const found of xmlElements(element)) {
            const key = `${found.ns} ${found.local}`;
            if (!index.has(key)) index.set(key, found);
        }
        indexes.set(element, index);
    }
    return index.get(`${ns} ${local}`);
}

const named = cachedBy<string, XmlElement[]>();

// Every child of this name in document order, as xmlChildren finds them.
export function childrenOf(element: XmlElement, ns: string, local: string): readonly XmlElement[] {
    if (element.children.length < SCANNED_BELOW) return xmlChildren(element, ns, local);
    return named(element, `${ns} ${local}`, () =>
        xmlElements(element).filter((found) => found.ns === ns && found.local === local),
    );
}

const picked = cachedBy<(child: XmlElement) => boolean, XmlElement | undefined>();

// The first child `test` picks; `test` is a module constant, so the answer is kept for it.
export function firstChildOf(element: XmlElement, test: (child: XmlElement) => boolean): XmlElement | undefined {
    if (element.children.length < SCANNED_BELOW) return xmlElements(element).find(test);
    return picked(element, test, () => xmlElements(element).find(test));
}

const prefixed = cachedBy<string, string | undefined>();

// A namespaced attribute, as xmlAttr finds it: it scans every prefixed attribute for one, and reads an unprefixed one
// directly.
export function prefixedAttrOf(element: XmlElement, ns: string, local: string): string | undefined {
    return prefixed(element, `${ns} ${local}`, () => xmlAttr(element, ns, local));
}
