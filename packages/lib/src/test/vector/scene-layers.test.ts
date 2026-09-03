import { describe, expect, test } from 'bun:test';
import { sceneLayers } from '../../vector/scene-layers';
import { elementToSvg } from '../../vector/scene-to-svg';
import {
    DEFAULT_ARROW_PROPS,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_SKETCH_PROPS,
    type VectorArrowElement,
    type VectorImageElement,
} from '../../vector/types';
import { richtext, scene, shape } from './element-factories';

describe('sceneLayers', () => {
    test('orders by fractional index and carries the element box and opacity', () => {
        const layers = sceneLayers(
            scene([
                shape({ id: 'b', type: 'rectangle', index: 'a1', x: 5, y: 6, angle: 15, opacity: 40 }),
                shape({ id: 'a', type: 'ellipse', index: 'a0' }),
            ]),
        );
        expect(layers.map((l) => l.id)).toEqual(['a', 'b']);
        expect(layers[1].box).toEqual({ x: 5, y: 6, width: 100, height: 60, angle: 15 });
        expect(layers[1].opacity).toBe(40);
    });

    test('svg content is the UNPOSITIONED fragment — the box carries the position', () => {
        const layers = sceneLayers(scene([shape({ id: 'a', type: 'rectangle', x: 30, y: 40, angle: 25 })]));
        const content = layers[0].content;
        expect('svg' in content && content.svg).not.toContain('translate(');
        expect('svg' in content && content.svg).not.toContain('rotate(');
    });

    test('rich text is the only html content, with its box style', () => {
        const layers = sceneLayers(scene([richtext({ id: 't', html: '<p>hi</p>' })]));
        const content = layers[0].content;
        expect('html' in content && content.html).toBe('<p>hi</p>');
        expect('html' in content && content.style).toContain('font-family');
    });

    test('padding rides the box style, and only when the box has some', () => {
        const padded = sceneLayers(scene([richtext({ id: 't', html: '<p>hi</p>', padding: 12 })]))[0].content;
        expect('html' in padded && padded.style).toContain('padding:12px;box-sizing:border-box');
        const plain = sceneLayers(scene([richtext({ id: 't', html: '<p>hi</p>' })]))[0].content;
        expect('html' in plain && plain.style).not.toContain('padding');
    });

    test('frame mode returns that frame’s elements only, already frame-relative', () => {
        const framed = {
            ...scene([
                shape({ id: 'in', type: 'rectangle', frameId: 'f1', x: 12, y: 13 }),
                shape({ id: 'out', type: 'rectangle', frameId: 'f2' }),
                shape({ id: 'loose', type: 'rectangle' }),
            ]),
            frames: [{ id: 'f1', index: 'a0', name: '', width: 1920, height: 1080, background: '' }],
        };
        const layers = sceneLayers(framed, { frameId: 'f1' });
        expect(layers.map((l) => l.id)).toEqual(['in']);
        expect(layers[0].box.x).toBe(12);
    });

    test('no frameId is the whole canvas, framed elements included', () => {
        const layers = sceneLayers(
            scene([
                shape({ id: 'framed', type: 'rectangle', frameId: 'f1' }),
                shape({ id: 'loose', type: 'rectangle', index: 'a1' }),
            ]),
        );
        expect(layers.map((l) => l.id)).toEqual(['framed', 'loose']);
    });

    test('an image is a layer only once its media resolves', () => {
        const img: VectorImageElement = {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'img',
            type: 'image',
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            angle: 0,
            index: 'a0',
            corners: 'straight',
            objectFit: 'contain',
            mediaName: 'pic.png',
        };
        expect(sceneLayers(scene([img]))).toEqual([]);
        const resolved = sceneLayers(scene([img]), { resolveMedia: () => 'data:image/png;base64,AAA' });
        expect(resolved.map((l) => l.id)).toEqual(['img']);
        expect('svg' in resolved[0].content && resolved[0].content.svg).toContain('href="data:image/png;base64,AAA"');
    });

    test('an elbow arrow renders through its scene-derived route, not its stored endpoints', () => {
        const arrow: VectorArrowElement = {
            ...DEFAULT_ELEMENT_PROPS,
            ...DEFAULT_SKETCH_PROPS,
            ...DEFAULT_ARROW_PROPS,
            id: 'ar',
            type: 'arrow',
            x: 100,
            y: 30,
            width: 200,
            height: 160,
            angle: 0,
            index: 'a2',
            points: '[[0,0],[200,160]]',
            startBinding: '{"elementId":"a","fixedPoint":[1,0.5]}',
            endBinding: '{"elementId":"b","fixedPoint":[0,0.5]}',
            elbow: true,
        };
        const layers = sceneLayers(
            scene([
                shape({ id: 'a', type: 'rectangle', index: 'a0' }),
                shape({ id: 'b', type: 'rectangle', index: 'a1', x: 300, y: 200 }),
                arrow,
            ]),
        );
        const content = layers[2].content;
        expect('svg' in content && content.svg).not.toBe(elementToSvg(arrow, { positioned: false }));
        expect(layers[2].box).toEqual({ x: 100, y: 30, width: 200, height: 160, angle: 0 });
    });

    test('an empty scene is no layers, not a throw', () => {
        expect(sceneLayers(scene([]))).toEqual([]);
    });
});
