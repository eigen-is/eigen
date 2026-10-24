// The one writer of the stored canvas shape — the counterpart of read-vector.ts. Fresh ids, the seed
// rule, the element and frame records and the live topmost index, over a plain Y.Doc: the editor's
// add path, the deck seeder, the demo seeder and the server's deck writer all write through here.
// React-free, so the API's transform process runs it too.

import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import { isValidFractionalIndex, keysAfter, orderByFractionalIndex } from './fractional-index';
import type { VectorFrame } from './frames';
import { DEFAULT_FRAME_BACKGROUND, FRAME_FIELDS } from './frames';
import type { StyleDefaults } from './kinds';
import { baseDefaultsFor, ELEMENT_KINDS, storedElementFields, storedFields } from './kinds';
import type { NewVectorElement, VectorElementType } from './types';

export function newElementId(): string {
    return `el-${nanoid(10)}`;
}

export function newFrameId(): string {
    return `fr-${nanoid(10)}`;
}

// A fresh roughjs jitter seed. One source: the creation paths, the duplicate pass and the draw drafts
// must draw from the same range or a preview pops on release.
export function randomSeed(): number {
    return 1 + Math.floor(Math.random() * (2 ** 31 - 1));
}

// The shared base props under the kind's own fields straight from the registry, styled by the HOST's
// table (vector draws rough and hatched, slides flat and solid) — a new kind needs no entry here, and a
// new host only a table. The base paint sits under the kind's overrides: rich text and images use the
// stroke as a border, so a fresh one is unframed until the user picks a stroke color. The panel's reset
// rows read baseDefaultsFor too, so a reset restores what creation gave.
export function kindDefaults<T extends VectorElementType>(type: T, style: StyleDefaults) {
    return { ...baseDefaultsFor(type, style), ...ELEMENT_KINDS[type].defaults(style) };
}

// One element into the doc's `elements` map at the given fractional index, under the kind's defaults
// and the host's style table. Honors a caller-supplied seed so a drag-create preview and its committed
// element share the same roughjs jitter (no visual pop on release). A caller-supplied `id` is the
// seeders': two peers seeding one empty deck write the same key, so they converge on one element
// instead of two. Nested in a live transact it joins that one, so a caller's origin and single-atom
// guarantee both survive.
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
        ...kindDefaults(partial.type, style),
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

// The whole frame record, through the FRAME_FIELDS allow-list — width/height come from the deck's
// slide size, so a stored size can never become a second source of truth for it. An unstated background is the shared
// DEFAULT_FRAME_BACKGROUND; a caller copying an existing frame passes its own. Joins a live transact.
export function writeFrameInDoc(doc: Y.Doc, frame: Partial<VectorFrame> & { id: string }): void {
    const map = new Y.Map<unknown>();
    const record = { name: '', background: DEFAULT_FRAME_BACKGROUND, ...frame };
    for (const [field, value] of storedFields(record, FRAME_FIELDS)) map.set(field, value);
    doc.transact(() => doc.getMap('frames').set(frame.id, map));
}

// Live topmost fractional index in an `elements` or `frames` map. Skips non-map entries and malformed
// index strings — a corrupt peer write must not make generateKeyBetween throw and brick adding
// (read-vector heals them on read).
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

// `count` keys that land frames directly after `afterId`, in order: at the front for null, at the end when it is
// unknown. `excludeId` drops the frame being moved from the order it is placed into. The editor's new slide, duplicate
// and move place one; Import… places a file's slides after the current one. Frames sharing the anchor's key, two peers'
// new slides after one slide, sort by id, and the keys go above all of them (keysAfter, as a z-order move places).
export function frameKeysAfter(
    framesMap: Y.Map<unknown>,
    afterId: string | null,
    count: number,
    excludeId?: string,
): string[] {
    // The frames in stored order, a shared key ordered by id; malformed entries skipped, as topmostIndex does.
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
