import { describe, expect, test } from 'bun:test';
import { DEFAULT_ELEMENT_PROPS, DEFAULT_SKETCH_PROPS, solidFill, type VectorShapeElement } from '@workspace/lib/vector';
import { sameLayerProps } from '../../../components/vector/element-layer';

const rect = (over: Partial<VectorShapeElement> = {}): VectorShapeElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    ...DEFAULT_SKETCH_PROPS,
    id: 'r1',
    type: 'rectangle',
    fill: solidFill('#dddddd'),
    fillStyle: 'solid',
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

    test('a new scene map re-renders only when the derived route actually changed', () => {
        const el = rect();
        const a = new Map([[el.id, el]]);
        const b = new Map([[el.id, el]]);
        // A plain rectangle derives no route, so a fresh map identity is not a reason to re-render.
        expect(sameLayerProps({ el, byId: a }, { el, byId: b })).toBe(true);
    });
});
