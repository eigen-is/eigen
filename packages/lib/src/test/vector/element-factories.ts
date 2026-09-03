// The shared element fixtures for the vector suites. A row is the base fields plus the kind's own
// style defaults, so a fixture never re-lists what the registry already owns.

import { ELEMENT_KINDS, VECTOR_STYLE_DEFAULTS } from '../../vector/kinds';
import {
    DEFAULT_ELEMENT_PROPS,
    type VectorElement,
    type VectorRectangleElement,
    type VectorRichTextElement,
    type VectorScene,
} from '../../vector/types';

const BASE = {
    ...DEFAULT_ELEMENT_PROPS,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    index: 'a0',
};

// Typed as the rectangle so `corners` is present, spread-only so the ellipse case doesn't trip the
// excess-property check on it. A fixed seed, since the kind's own default (0) is the writer's placeholder.
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

export function scene(elements: VectorElement[], background = 'transparent'): VectorScene {
    return { meta: { background, gridSize: 20 }, frames: [], elements };
}
