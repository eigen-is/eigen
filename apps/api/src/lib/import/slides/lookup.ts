// The pptx reader's lookups into an element, each scan of many children done once, and the work budget a read
// charges, so whatever a file repeats or keys a cache by costs the read no more than its cap.

import type { XmlElement } from '../../core/xml';
import { xmlAttr, xmlChild, xmlChildren, xmlElements } from '../../core/xml';
import type { Budget } from '../../ooxml/budget';
import { budget } from '../../ooxml/budget';
import { IMPORT_MESSAGES } from '../messages';

// Every lookup the reader makes into an element goes through here. An element of a layout, master, theme or the
// presentation is looked into again for every slide, shape, paragraph and run that inherits it, and among its children
// a file can put any number of junk elements: each element's children are scanned once, whatever is looked up later.
// One of a few children is scanned each time instead, which costs no more than the index and keeps no memory.
const SCANNED_BELOW = 16;

// What the read under way may still do, in children scanned, colors resolved, characters, shapes and charts read. The
// caches here are keyed by element and live past a read, so the budget is the module's while a read runs; a read is
// synchronous, so no other read charges it meanwhile.
let work: Budget = budget(Number.POSITIVE_INFINITY, IMPORT_MESSAGES.pptx.tooLarge);

export function withWorkBudget<T>(units: number, read: () => T): T {
    const outer = work;
    work = budget(units, IMPORT_MESSAGES.pptx.tooLarge);
    try {
        return read();
    } finally {
        work = outer;
    }
}

// Whatever a file repeats or keys a cache by, each unit of work proportional to it is charged here before it is done.
export function charge(units: number): void {
    work.charge(units);
}

// Whether the read under way can still do this much, charging nothing: what may be left out, a chart, asks first.
export function affords(units: number): boolean {
    return work.affords(units);
}

// Charges this much only when the read can still do it: work that may be left out asks before it begins.
export function spend(units: number): boolean {
    return work.spend(units);
}

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
        charge(element.children.length);
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
    return named(element, `${ns} ${local}`, () => {
        charge(element.children.length);
        return xmlElements(element).filter((found) => found.ns === ns && found.local === local);
    });
}

const picked = cachedBy<(child: XmlElement) => boolean, XmlElement | undefined>();

// The first child `test` picks; `test` is a module constant, so the answer is kept for it.
export function firstChildOf(element: XmlElement, test: (child: XmlElement) => boolean): XmlElement | undefined {
    if (element.children.length < SCANNED_BELOW) return xmlElements(element).find(test);
    return picked(element, test, () => {
        charge(element.children.length);
        return xmlElements(element).find(test);
    });
}

const prefixed = new WeakMap<XmlElement, Map<string, string | undefined>>();

// A namespaced attribute, as xmlAttr finds it: it scans every prefixed attribute for one, and reads an unprefixed one
// directly. Kept only for an element of many: a run's hyperlink is read once, and keeping it would hold every run's.
export function prefixedAttrOf(element: XmlElement, ns: string, local: string): string | undefined {
    const key = `${ns} ${local}`;
    const known = prefixed.get(element);
    if (known?.has(key)) return known.get(key);
    const count = Object.keys(element.attributeNs).length;
    if (count < SCANNED_BELOW) return xmlAttr(element, ns, local);
    charge(count);
    const value = xmlAttr(element, ns, local);
    prefixed.set(element, (known ?? new Map()).set(key, value));
    return value;
}
