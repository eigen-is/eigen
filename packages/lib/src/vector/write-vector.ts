// The one writer of the stored canvas shape, the counterpart of the reader: fresh ids, the seed rule, the element and
// frame records and the live topmost index, over a plain Y.Doc. Every caller that adds to a canvas writes through
// here, such as the editor's add path and the deck seeders. It is React-free, so the API's transform process runs it.

import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import { isValidFractionalIndex, keysAfter, orderByFractionalIndex } from './fractional-index';
import type { VectorFrame } from './frames';
import { DEFAULT_FRAME_BACKGROUND, FRAME_FIELDS } from './frames';
import type { StyleDefaults } from './kinds';
import {
    baseDefaultsFor,
    ELEMENT_KINDS,
    isTextBox,
    storedElementFields,
    storedFields,
    textBoxOverrides,
} from './kinds';
import type { NewVectorElement, VectorElementType } from './types';

export function newElementId(): string {
    return `el-${nanoid(10)}`;
}

export function newFrameId(): string {
    return `fr-${nanoid(10)}`;
}

// A new roughjs jitter seed. Every path that creates an element and every draw preview takes its seed from this one
// range, so a preview doesn't change its look when the user lets go.
export function randomSeed(): number {
    return 1 + Math.floor(Math.random() * (2 ** 31 - 1));
}

// A new element's fields: the shared base, with the kind's own base overrides, under the kind's own fields. The
// host's style table styles both, so a new kind needs no entry here and a new host needs only a table.
export function kindDefaults<T extends VectorElementType>(type: T, style: StyleDefaults) {
    return { ...baseDefaultsFor(type, style), ...ELEMENT_KINDS[type].defaults(style) };
}

// A new text box: a new rectangle under the text box's own overrides. It lives here and not beside those overrides,
// because it reads the registry's defaults and a kind module must not reach the registry.
export function textBoxDefaults(style: StyleDefaults) {
    return { ...kindDefaults('rectangle', style), ...textBoxOverrides(style) };
}

// One element into the doc's `elements` map at the given fractional index, under its kind's defaults in the host's
// style table, or a text box's. A caller-supplied seed lets a drag-create preview and its committed element share one
// roughjs jitter, so nothing pops on release. A caller-supplied `id` is the seeders': two peers seeding one empty deck
// write the same key, so they converge on one element instead of two. Nested in a live transact it joins that one, so
// a caller's origin and single-atom guarantee both survive.
export function writeElementInDoc(
    doc: Y.Doc,
    partial: NewVectorElement,
    index: string,
    style: StyleDefaults,
    id: string = newElementId(),
): string {
    const seed = partial.seed ?? randomSeed();
    const record = {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        angle: 0,
        ...(isTextBox(partial) ? textBoxDefaults(style) : kindDefaults(partial.type, style)),
        ...partial,
        id,
        type: partial.type,
        seed,
        index,
    };
    const element = new Y.Map<unknown>();
    for (const [field, value] of storedElementFields(record)) element.set(field, value);
    doc.transact(() => doc.getMap('elements').set(id, element));
    return id;
}

// The whole frame record, through the FRAME_FIELDS allow-list. A frame stores no size, because the deck's slide size
// is the one truth for it. A frame with no background gets DEFAULT_FRAME_BACKGROUND, and a caller copying a frame
// passes its own. Inside a live transact it joins that one.
export function writeFrameInDoc(doc: Y.Doc, frame: Partial<VectorFrame> & { id: string }): void {
    const map = new Y.Map<unknown>();
    const record = { name: '', background: DEFAULT_FRAME_BACKGROUND, ...frame };
    for (const [field, value] of storedFields(record, FRAME_FIELDS)) map.set(field, value);
    doc.transact(() => doc.getMap('frames').set(frame.id, map));
}

// The topmost fractional index in an `elements` or `frames` map. It skips entries that are not maps and indexes that
// don't parse, because a corrupt peer write must not make generateKeyBetween throw and stop every add. The reader
// heals those on read.
export function topmostIndex(map: Y.Map<unknown>): string | null {
    let topmost: string | null = null;
    for (const value of map.values()) {
        if (!(value instanceof Y.Map)) continue;
        const idx = value.get('index');
        if (typeof idx !== 'string' || !isValidFractionalIndex(idx, undefined, undefined)) continue;
        if (topmost === null || idx > topmost) topmost = idx;
    }
    return topmost;
}

// `count` keys that place frames right after `afterId`, in order. A null `afterId` places them first, and an unknown
// one places them last. `excludeId` leaves out the frame being moved. Two peers may each add a slide after the same
// slide, so frames can share a key. Those sort by id, and the new keys go above all of them, as keysAfter places a
// z-order move.
export function frameKeysAfter(
    framesMap: Y.Map<unknown>,
    afterId: string | null,
    count: number,
    excludeId?: string,
): string[] {
    // The frames in stored order. Malformed entries are skipped, as in topmostIndex.
    const frames: { id: string; index: string }[] = [];
    for (const value of framesMap.values()) {
        if (!(value instanceof Y.Map)) continue;
        const id = value.get('id');
        const index = value.get('index');
        if (typeof id !== 'string' || typeof index !== 'string' || id === excludeId) continue;
        if (!isValidFractionalIndex(index, undefined, undefined)) continue;
        frames.push({ id, index });
    }
    return keysAfter(orderByFractionalIndex(frames), afterId, count);
}
