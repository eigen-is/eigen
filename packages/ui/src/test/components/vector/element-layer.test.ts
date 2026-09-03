import { describe, expect, test } from 'bun:test';
import { DEFAULT_ELEMENT_PROPS, DEFAULT_SKETCH_PROPS, solidFill, type VectorShapeElement } from '@workspace/lib/vector';
import { layerStyle, sameLayerProps } from '../../../components/vector/element-layer';

const rect = (over: Partial<VectorShapeElement> = {}): VectorShapeElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    ...DEFAULT_SKETCH_PROPS,
    id: 'r1',
    type: 'rectangle',
    fill: solidFill('#dddddd'),
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    seed: 1,
    index: 'a0',
    corners: 'straight',
    ...over,
});

describe('sameLayerProps', () => {
    test('identical field values skip the re-render even for a fresh object', () => {
        expect(sameLayerProps({ el: rect() }, { el: rect() })).toBe(true);
    });

    test('a changed stored field re-renders', () => {
        expect(sameLayerProps({ el: rect() }, { el: rect({ x: 5 }) })).toBe(false);
    });

    test('a new resolveMedia identity re-renders', () => {
        const el = rect();
        expect(sameLayerProps({ el, resolveMedia: () => null }, { el, resolveMedia: () => null })).toBe(false);
    });

    test('an in-place editor mounted in the layer always re-renders', () => {
        const el = rect();
        // children is a fresh React node every parent render; the layer hosting an editor must follow it.
        expect(sameLayerProps({ el }, { el, children: 'editor' })).toBe(false);
        expect(sameLayerProps({ el, children: 'a' }, { el, children: 'b' })).toBe(false);
    });

    test('a new scene map re-renders only when the derived route actually changed', () => {
        const el = rect();
        const a = new Map([[el.id, el]]);
        const b = new Map([[el.id, el]]);
        // A plain rectangle derives no route, so a fresh map identity is not a reason to re-render.
        expect(sameLayerProps({ el, byId: a }, { el, byId: b })).toBe(true);
    });
});

describe('layerStyle', () => {
    // The box is pinned with CSS transforms, never fractional left/top: the browser pixel-snaps a box
    // origin before painting the element's svg, which is what shifted every element up to half a pixel
    // off the float coordinates the old single-svg renderer drew at.
    const box = { x: 12.5, y: -3.25, width: 40, height: 20, angle: 0 };

    test('an unrotated layer translates to its box origin and leaves left/top at zero', () => {
        expect(layerStyle({ box, opacity: 100 })).toEqual({
            left: 0,
            top: 0,
            width: 40,
            height: 20,
            transform: 'translate(12.5px, -3.25px)',
            opacity: undefined,
        });
    });

    test('a rotated layer composes rotate after translate, pivoting on the default centre origin', () => {
        // transform-origin is the box centre, and translate is origin-independent, so this is the old
        // renderer's `translate(x y) rotate(angle w/2 h/2)` exactly.
        expect(layerStyle({ box: { ...box, angle: 30 }, opacity: 100 }).transform).toBe(
            'translate(12.5px, -3.25px) rotate(30deg)',
        );
    });

    test('opacity rides on the layer, and only below full', () => {
        expect(layerStyle({ box, opacity: 40 }).opacity).toBe(0.4);
        expect(layerStyle({ box, opacity: 100 }).opacity).toBeUndefined();
    });
});
