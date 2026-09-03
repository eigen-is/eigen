// The shared element fixtures for the vector suites. A row is the base fields plus the kind's own
// style defaults, so a fixture never re-lists what the registry already owns.

import { VECTOR_STYLE_DEFAULTS } from '../../vector/kinds';
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
// excess-property check on it.
const SHAPE_BASE: Omit<VectorRectangleElement, 'id' | 'type'> = {
    ...BASE,
    fill: VECTOR_STYLE_DEFAULTS.fill,
    fillStyle: VECTOR_STYLE_DEFAULTS.fillStyle,
    roughness: VECTOR_STYLE_DEFAULTS.roughness,
    seed: 1,
    corners: VECTOR_STYLE_DEFAULTS.corners,
};

const RICHTEXT_BASE: Omit<VectorRichTextElement, 'id' | 'type'> = {
    ...BASE,
    fill: VECTOR_STYLE_DEFAULTS.fill,
    fillStyle: VECTOR_STYLE_DEFAULTS.fillStyle,
    corners: VECTOR_STYLE_DEFAULTS.corners,
    html: '',
    fontFamily: VECTOR_STYLE_DEFAULTS.fontFamily,
    fontSize: VECTOR_STYLE_DEFAULTS.fontSize,
    fontWeight: 'normal',
    fontStyle: 'normal',
    textDecoration: 'none',
    textAlign: 'left',
    verticalAlign: 'top',
    color: VECTOR_STYLE_DEFAULTS.color,
    letterSpacing: 0,
    lineHeight: 1.2,
    highlightColor: 'transparent',
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
