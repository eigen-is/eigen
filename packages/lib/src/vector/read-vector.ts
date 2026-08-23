// Materialize a vector container's Y.Doc into a plain VectorScene. Worker-safe (yjs only),
// mirrors document/slides.ts readDeckFromDoc but per-element-Map. Every v1 field is a scalar
// or string (CONTRACT §A), so — unlike slides' commentCardIds — there is no Y.Array branch;
// primitive reads suffice even when the server hydrates values via Y.applyUpdate.

import type * as Y from 'yjs';
import { orderByFractionalIndex, syncInvalidIndices } from './fractional-index';
import {
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_FONT_FAMILY,
    DEFAULT_FONT_SIZE,
    DEFAULT_SCENE_META,
    DEFAULT_SHAPE_ROUNDNESS,
    FILL_STYLES,
    isVectorElementType,
    ROUNDNESS,
    STROKE_STYLES,
    TEXT_ALIGNS,
    type VectorElement,
    type VectorElementBase,
    type VectorScene,
} from './types';

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
        x: num(value.get('x'), 0),
        y: num(value.get('y'), 0),
        width: num(value.get('width'), 0),
        height: num(value.get('height'), 0),
        angle: num(value.get('angle'), 0),
        strokeColor: str(value.get('strokeColor'), DEFAULT_ELEMENT_PROPS.strokeColor),
        backgroundColor: str(value.get('backgroundColor'), DEFAULT_ELEMENT_PROPS.backgroundColor),
        fillStyle: oneOf(value.get('fillStyle'), FILL_STYLES, DEFAULT_ELEMENT_PROPS.fillStyle),
        strokeWidth: num(value.get('strokeWidth'), DEFAULT_ELEMENT_PROPS.strokeWidth),
        strokeStyle: oneOf(value.get('strokeStyle'), STROKE_STYLES, DEFAULT_ELEMENT_PROPS.strokeStyle),
        roughness: num(value.get('roughness'), DEFAULT_ELEMENT_PROPS.roughness),
        seed: num(value.get('seed'), 0),
        opacity: num(value.get('opacity'), DEFAULT_ELEMENT_PROPS.opacity),
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
                text: str(value.get('text'), ''),
                fontSize: num(value.get('fontSize'), DEFAULT_FONT_SIZE),
                fontFamily: str(value.get('fontFamily'), DEFAULT_FONT_FAMILY),
                textAlign: oneOf(value.get('textAlign'), TEXT_ALIGNS, 'left'),
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
