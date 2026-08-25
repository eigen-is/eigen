// Materialize a vector container's Y.Doc into a plain VectorScene. Worker-safe (yjs only),
// mirrors document/slides.ts readDeckFromDoc but per-element-Map. Every v1 field is a scalar
// or string, so — unlike slides' commentCardIds — there is no Y.Array branch;
// primitive reads suffice even when the server hydrates values via Y.applyUpdate.

import type * as Y from 'yjs';
import { orderByFractionalIndex, syncInvalidIndices } from './fractional-index';
import {
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_SCENE_META,
    DEFAULT_SHAPE_ROUNDNESS,
    DEFAULT_TEXT_PROPS,
    FILL_STYLES,
    isVectorElementType,
    ROUNDNESS,
    STROKE_STYLES,
    TEXT_ALIGNS,
    type VectorElement,
    type VectorElementBase,
    type VectorScene,
} from './types';

// Sanity bound on spatial fields. The doc is a boundary (any peer writes it); without a cap
// one client's corrupt write (say 1e15 from a math bug) freezes every other peer — rough
// fill cost scales with element area.
const MAX_COORD = 1_000_000;

export function readVectorFromDoc(doc: Y.Doc): VectorScene {
    const elementsMap = doc.getMap('elements');
    const metaMap = doc.getMap('meta');

    const elements: VectorElement[] = [];
    for (const value of elementsMap.values()) {
        const el = readElement(value);
        if (el) elements.push(el);
    }

    // Order by z-index, then heal any collisions/invalid runs from concurrent inserts.
    const ordered = syncInvalidIndices(orderByFractionalIndex(elements));

    const background = str(metaMap.get('background'), DEFAULT_SCENE_META.background);
    const gridSize = num(metaMap.get('gridSize'), DEFAULT_SCENE_META.gridSize);
    return { elements: ordered, meta: { background, gridSize } };
}

function readElement(value: unknown): VectorElement | null {
    // A per-element Y.Map exposes .get; foreign/partial values without it are skipped.
    if (!isYMapLike(value)) return null;
    const type = value.get('type');
    const id = value.get('id');
    if (typeof id !== 'string' || !isVectorElementType(type)) return null;

    const base: VectorElementBase = {
        id,
        type,
        x: coord(value.get('x')),
        y: coord(value.get('y')),
        width: coord(value.get('width')),
        height: coord(value.get('height')),
        angle: num(value.get('angle'), 0),
        strokeColor: str(value.get('strokeColor'), DEFAULT_ELEMENT_PROPS.strokeColor),
        backgroundColor: str(value.get('backgroundColor'), DEFAULT_ELEMENT_PROPS.backgroundColor),
        fillStyle: oneOf(value.get('fillStyle'), FILL_STYLES, DEFAULT_ELEMENT_PROPS.fillStyle),
        strokeWidth: num(value.get('strokeWidth'), DEFAULT_ELEMENT_PROPS.strokeWidth),
        strokeStyle: oneOf(value.get('strokeStyle'), STROKE_STYLES, DEFAULT_ELEMENT_PROPS.strokeStyle),
        roughness: num(value.get('roughness'), DEFAULT_ELEMENT_PROPS.roughness),
        seed: num(value.get('seed'), 0),
        opacity: Math.min(100, Math.max(0, num(value.get('opacity'), DEFAULT_ELEMENT_PROPS.opacity))),
        locked: bool(value.get('locked'), DEFAULT_ELEMENT_PROPS.locked),
        index: str(value.get('index'), ''),
    };

    switch (base.type) {
        case 'rectangle':
        case 'diamond':
        case 'ellipse':
            return {
                ...base,
                type: base.type,
                roundness: oneOf(value.get('roundness'), ROUNDNESS, DEFAULT_SHAPE_ROUNDNESS),
            };
        case 'text':
            return {
                ...base,
                type: 'text',
                text: str(value.get('text'), DEFAULT_TEXT_PROPS.text),
                fontSize: num(value.get('fontSize'), DEFAULT_TEXT_PROPS.fontSize),
                fontFamily: str(value.get('fontFamily'), DEFAULT_TEXT_PROPS.fontFamily),
                textAlign: oneOf(value.get('textAlign'), TEXT_ALIGNS, DEFAULT_TEXT_PROPS.textAlign),
            };
        case 'image':
            return { ...base, type: 'image', mediaName: str(value.get('mediaName'), '') };
    }
}

type YMapLike = { get(key: string): unknown };

function isYMapLike(value: unknown): value is YMapLike {
    return typeof value === 'object' && value !== null && 'get' in value && typeof value.get === 'function';
}

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function coord(v: unknown): number {
    return Math.min(MAX_COORD, Math.max(-MAX_COORD, num(v, 0)));
}

function str(v: unknown, fallback: string): string {
    return typeof v === 'string' ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
    return typeof v === 'boolean' ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
    for (const option of allowed) {
        if (option === v) return option;
    }
    return fallback;
}
