// Materialize a vector container's Y.Doc into a plain VectorScene. Worker-safe (yjs only),
// mirrors document/slides.ts readDeckFromDoc but per-element-Map. Every v1 field is a scalar
// or string, so primitive reads suffice even when the server hydrates values via Y.applyUpdate.
// Per-kind field validation lives in the registry (kinds/); this module owns the scene-level passes.

import type * as Y from 'yjs';
import { parseBackgroundFill, serializeBackgroundFill } from './fill';
import { orderByFractionalIndex, syncInvalidIndices } from './fractional-index';
import { FRAME_HEIGHT, FRAME_WIDTH, type VectorFrame } from './frames';
import { ELEMENT_KINDS, isVectorElementType } from './kinds';
import {
    bool,
    cleanStr,
    color,
    coord,
    isYMapLike,
    num,
    oneOf,
    size,
    str,
    strokeWidth,
    type YMapLike,
} from './kinds/read-fields';
import {
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_SCENE_META,
    isBindable,
    parseBinding,
    parseIdList,
    STROKE_STYLES,
    serializeIdList,
    type VectorElement,
    type VectorElementBase,
    type VectorElementType,
    type VectorScene,
} from './types';

export function readVectorFromDoc(doc: Y.Doc): VectorScene {
    const elementsMap = doc.getMap('elements');
    const framesMap = doc.getMap('frames');
    const metaMap = doc.getMap('meta');

    const frames = readFrames(framesMap);
    const elements: VectorElement[] = [];
    for (const value of elementsMap.values()) {
        const el = readElement(value);
        if (el) elements.push(el);
    }

    // Now that every element is known, unbind any arrow whose bound shape is gone.
    clearDanglingBindings(elements);
    rehomeDanglingFrames(elements, frames);

    // Order by z-index, then heal any collisions/invalid runs from concurrent inserts.
    const ordered = syncInvalidIndices(orderByFractionalIndex(elements));

    const background = color(metaMap.get('background'), DEFAULT_SCENE_META.background);
    const gridSize = num(metaMap.get('gridSize'), DEFAULT_SCENE_META.gridSize);
    return { elements: ordered, frames, meta: { background, gridSize } };
}

// Frames are ordered by fractional index like elements, and heal the same way. Every frame is
// 16:9, so the size is the constant, never a stored field.
function readFrames(framesMap: Y.Map<unknown>): VectorFrame[] {
    const frames: VectorFrame[] = [];
    for (const value of framesMap.values()) {
        if (!isYMapLike(value)) continue;
        const id = value.get('id');
        if (typeof id !== 'string' || id === '') continue;
        frames.push({
            id,
            index: str(value.get('index'), ''),
            name: cleanStr(value.get('name'), ''),
            width: FRAME_WIDTH,
            height: FRAME_HEIGHT,
            background: serializeBackgroundFill(parseBackgroundFill(str(value.get('background'), ''))),
        });
    }
    return syncInvalidIndices(orderByFractionalIndex(frames));
}

function readElement(value: unknown): VectorElement | null {
    // A per-element Y.Map exposes .get; foreign/partial values without it are skipped.
    if (!isYMapLike(value)) return null;
    const type = value.get('type');
    const id = value.get('id');
    if (typeof id !== 'string' || !isVectorElementType(type)) return null;
    return ELEMENT_KINDS[type].read(value, readBase(value, id, type));
}

function readBase(value: YMapLike, id: string, type: VectorElementType): VectorElementBase {
    return {
        id,
        type,
        x: coord(value.get('x')),
        y: coord(value.get('y')),
        width: size(value.get('width')),
        height: size(value.get('height')),
        angle: num(value.get('angle'), 0),
        index: str(value.get('index'), ''),
        frameId: str(value.get('frameId'), ''),
        commentCardIds: serializeIdList(parseIdList(str(value.get('commentCardIds'), ''))),
        opacity: Math.min(100, Math.max(0, num(value.get('opacity'), DEFAULT_ELEMENT_PROPS.opacity))),
        locked: bool(value.get('locked'), DEFAULT_ELEMENT_PROPS.locked),
        strokeColor: color(value.get('strokeColor'), DEFAULT_ELEMENT_PROPS.strokeColor),
        strokeWidth: strokeWidth(value.get('strokeWidth')),
        strokeStyle: oneOf(value.get('strokeStyle'), STROKE_STYLES, DEFAULT_ELEMENT_PROPS.strokeStyle),
    };
}

// Second pass: a binding whose target no longer exists — or is no longer a bindable shape — is
// unbound. Mutates the freshly-materialized elements in place; the Y.Doc is never written, so
// the next real write of that arrow is what persists the cleared value.
function clearDanglingBindings(elements: VectorElement[]): void {
    const bindable = new Set<string>();
    for (const el of elements) {
        if (isBindable(el)) bindable.add(el.id);
    }
    for (const el of elements) {
        if (el.type !== 'arrow') continue;
        if (!targetPresent(el.startBinding, bindable)) el.startBinding = '';
        if (!targetPresent(el.endBinding, bindable)) el.endBinding = '';
    }
}

function targetPresent(bindingStr: string, bindable: Set<string>): boolean {
    const parsed = parseBinding(bindingStr);
    return parsed !== null && bindable.has(parsed.elementId);
}

// A frameId pointing at a frame that is gone would hide the element (frame mode renders one frame's
// elements). Re-home it to the lowest-index frame at READ time — the doc is never written, so the next
// real write of that element is what persists it, exactly like clearDanglingBindings.
function rehomeDanglingFrames(elements: VectorElement[], frames: VectorFrame[]): void {
    const known = new Set(frames.map((f) => f.id));
    const home = frames.length > 0 ? frames[0].id : '';
    for (const el of elements) {
        if (el.frameId !== '' && !known.has(el.frameId)) el.frameId = home;
    }
}
