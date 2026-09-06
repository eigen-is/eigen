// The shared element fixtures for the vector suites. A row is the base fields plus the kind's own
// style defaults, so a fixture never re-lists what the registry already owns.

import { serializePoints } from '../../vector/geometry';
import { ELEMENT_KINDS, VECTOR_STYLE_DEFAULTS } from '../../vector/kinds';
import {
    DEFAULT_ELEMENT_PROPS,
    type VectorArrowElement,
    type VectorElement,
    type VectorEllipseElement,
    type VectorImageElement,
    type VectorLinearElement,
    type VectorRectangleElement,
    type VectorRichTextElement,
    type VectorScene,
} from '../../vector/types';

// A fixed seed and the host's roughness, since the shared table's are the reader's fallbacks (0/0).
const BASE = {
    ...DEFAULT_ELEMENT_PROPS,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    index: 'a0',
    roughness: VECTOR_STYLE_DEFAULTS.roughness,
    seed: 1,
};

// Typed as the rectangle so `corners` is present, spread-only so the ellipse case doesn't trip the
// excess-property check on it.
const SHAPE_BASE: Omit<VectorRectangleElement, 'id' | 'type'> = {
    ...BASE,
    ...ELEMENT_KINDS.rectangle.defaults(VECTOR_STYLE_DEFAULTS),
    seed: 1,
};

const RICHTEXT_BASE: Omit<VectorRichTextElement, 'id' | 'type'> = {
    ...BASE,
    ...ELEMENT_KINDS.richtext.defaults(VECTOR_STYLE_DEFAULTS),
};

export function shape(over: Partial<VectorElement> & Pick<VectorElement, 'id' | 'type'>): VectorElement {
    const el = { ...SHAPE_BASE, ...over };
    if (el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse') return el;
    throw new Error('shape() expects a shape type');
}

export function richtext(
    over: Partial<VectorRichTextElement> & Pick<VectorRichTextElement, 'id'>,
): VectorRichTextElement {
    return { ...RICHTEXT_BASE, type: 'richtext', ...over };
}

// The ellipse has no `corners`, so it cannot ride SHAPE_BASE (whose rectangle typing carries one) —
// a round-trip fixture must be exactly the kind's own field set.
export function ellipse(over: Partial<VectorEllipseElement> & Pick<VectorEllipseElement, 'id'>): VectorEllipseElement {
    return { ...BASE, ...ELEMENT_KINDS.ellipse.defaults(VECTOR_STYLE_DEFAULTS), type: 'ellipse', seed: 1, ...over };
}

export function image(over: Partial<VectorImageElement> & Pick<VectorImageElement, 'id'>): VectorImageElement {
    return { ...BASE, ...ELEMENT_KINDS.image.defaults(VECTOR_STYLE_DEFAULTS), type: 'image', ...over };
}

// A stroke/line without points reads back as null, so the fixture carries a real two-point path.
const POINTS = serializePoints([
    { x: 0, y: 0 },
    { x: 100, y: 60 },
]);

export function linear(
    over: Partial<VectorLinearElement> & Pick<VectorLinearElement, 'id' | 'type'>,
): VectorLinearElement {
    return { ...BASE, ...ELEMENT_KINDS.freedraw.defaults(VECTOR_STYLE_DEFAULTS), points: POINTS, seed: 1, ...over };
}

export function arrow(over: Partial<VectorArrowElement> & Pick<VectorArrowElement, 'id'>): VectorArrowElement {
    return {
        ...BASE,
        ...ELEMENT_KINDS.arrow.defaults(VECTOR_STYLE_DEFAULTS),
        type: 'arrow',
        points: POINTS,
        seed: 1,
        ...over,
    };
}

export function scene(elements: VectorElement[], background = 'transparent'): VectorScene {
    return { meta: { background }, frames: [], elements };
}

// The scene lookup every geometry entry point takes, from the elements a test cares about.
export function byIdOf(...els: VectorElement[]): Map<string, VectorElement> {
    return new Map(els.map((el) => [el.id, el]));
}
