import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { isValidFractionalIndex } from '../../vector/fractional-index';
import { readVectorFromDoc } from '../../vector/read-vector';
import { DEFAULT_ELEMENT_PROPS, DEFAULT_SCENE_META, ELEMENT_FIELDS } from '../../vector/types';

function writeElement(map: Y.Map<unknown>, id: string, fields: Record<string, unknown>) {
    const m = new Y.Map();
    m.set('id', id);
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    map.set(id, m);
}

function docWith(build: (elements: Y.Map<unknown>, meta: Y.Map<unknown>) => void): Y.Doc {
    const doc = new Y.Doc();
    doc.transact(() => build(doc.getMap('elements'), doc.getMap('meta')));
    return doc;
}

describe('readVectorFromDoc', () => {
    test('materializes elements ordered by fractional index with meta', () => {
        const doc = docWith((elements, meta) => {
            meta.set('background', '#ffffff');
            meta.set('gridSize', 32);
            writeElement(elements, 'second', { type: 'rectangle', index: 'a1', roundness: 'round' });
            writeElement(elements, 'first', { type: 'ellipse', index: 'a0' });
        });
        const scene = readVectorFromDoc(doc);
        expect(scene.elements.map((e) => e.id)).toEqual(['first', 'second']);
        expect(scene.meta).toEqual({ background: '#ffffff', gridSize: 32 });
    });

    test('applies defaults for missing fields and ignores foreign keys', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'e', { type: 'rectangle', index: 'a0', __foreign: 'ignored', style: { x: 1 } });
        });
        const [el] = readVectorFromDoc(doc).elements;
        expect(el.strokeColor).toBe(DEFAULT_ELEMENT_PROPS.strokeColor);
        expect(el.strokeWidth).toBe(DEFAULT_ELEMENT_PROPS.strokeWidth);
        expect(el.opacity).toBe(DEFAULT_ELEMENT_PROPS.opacity);
        expect(Object.keys(el)).not.toContain('__foreign');
        expect(Object.keys(el)).not.toContain('style');
    });

    test('materializes text and image type-specific fields', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 't', {
                type: 'text',
                index: 'a0',
                text: 'hello',
                fontSize: 24,
                fontFamily: 'Inter',
                textAlign: 'center',
            });
            writeElement(elements, 'i', { type: 'image', index: 'a1', mediaName: 'pic.png' });
        });
        const [text, image] = readVectorFromDoc(doc).elements;
        expect(text).toMatchObject({
            type: 'text',
            text: 'hello',
            fontSize: 24,
            fontFamily: 'Inter',
            textAlign: 'center',
        });
        expect(image).toMatchObject({ type: 'image', mediaName: 'pic.png' });
    });

    test('skips entries with an invalid type or non-string id', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'ok', { type: 'rectangle', index: 'a0' });
            writeElement(elements, 'bad-type', { type: 'hexagon', index: 'a1' });
            // non-string id
            const m = new Y.Map();
            m.set('id', 42);
            m.set('type', 'rectangle');
            m.set('index', 'a2');
            elements.set('numeric', m);
        });
        const scene = readVectorFromDoc(doc);
        expect(scene.elements.map((e) => e.id)).toEqual(['ok']);
    });

    test('repairs duplicate indices on load', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'a', { type: 'rectangle', index: 'a0' });
            writeElement(elements, 'b', { type: 'rectangle', index: 'a0' });
            writeElement(elements, 'c', { type: 'rectangle', index: 'a1' });
        });
        const scene = readVectorFromDoc(doc);
        const indices = scene.elements.map((e) => e.index);
        expect(new Set(indices).size).toBe(3);
        for (let i = 0; i < scene.elements.length; i++) {
            expect(isValidFractionalIndex(indices[i], indices[i - 1], indices[i + 1])).toBe(true);
        }
    });

    test('reads a server-hydrated doc (roots are AbstractType after applyUpdate)', () => {
        const src = docWith((elements, meta) => {
            meta.set('background', 'transparent');
            meta.set('gridSize', 20);
            writeElement(elements, 'a', { type: 'rectangle', index: 'a0', x: 5, y: 6 });
        });
        const server = new Y.Doc();
        Y.applyUpdate(server, Y.encodeStateAsUpdate(src));
        expect(server.share.get('elements')?.constructor.name).toBe('AbstractType');

        const scene = readVectorFromDoc(server);
        expect(scene.elements).toHaveLength(1);
        expect(scene.elements[0]).toMatchObject({ id: 'a', x: 5, y: 6 });
    });

    test('clamps hostile spatial values and opacity', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'big', {
                type: 'rectangle',
                index: 'a0',
                x: -1e15,
                y: 2e9,
                width: 1e12,
                height: Number.NaN,
                opacity: 250,
            });
        });
        const [el] = readVectorFromDoc(doc).elements;
        expect(el).toMatchObject({ x: -1_000_000, y: 1_000_000, width: 1_000_000, height: 0, opacity: 100 });
    });

    test('empty doc yields an empty scene with default meta', () => {
        const scene = readVectorFromDoc(new Y.Doc());
        expect(scene.elements).toEqual([]);
        expect(scene.meta).toEqual({ background: 'transparent', gridSize: 20 });
    });

    test('materializes a linear element with points and roundness', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'ln', {
                type: 'line',
                index: 'a0',
                points: '[[0,0],[40,10],[80,-5]]',
                roundness: 'round',
            });
            writeElement(elements, 'fd', { type: 'freedraw', index: 'a1', points: '[[0,0],[3,4]]' });
        });
        const [line, freedraw] = readVectorFromDoc(doc).elements;
        expect(line).toMatchObject({ type: 'line', points: '[[0,0],[40,10],[80,-5]]', roundness: 'round' });
        // freedraw ignores roundness but the reader still falls it back to the linear default
        expect(freedraw).toMatchObject({ type: 'freedraw', points: '[[0,0],[3,4]]', roundness: 'sharp' });
    });

    test('skips a linear element whose points are missing, empty, or garbage', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'ok', { type: 'line', index: 'a0', points: '[[0,0],[10,0]]' });
            writeElement(elements, 'missing', { type: 'line', index: 'a1' });
            writeElement(elements, 'empty', { type: 'freedraw', index: 'a2', points: '[]' });
            writeElement(elements, 'garbage', { type: 'line', index: 'a3', points: '[[0,0],[1]]' });
        });
        expect(readVectorFromDoc(doc).elements.map((e) => e.id)).toEqual(['ok']);
    });

    test('clamps hostile point coordinates per axis', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'l', { type: 'line', index: 'a0', points: '[[0,0],[1e15,-2e9]]' });
        });
        const [el] = readVectorFromDoc(doc).elements;
        expect(el).toMatchObject({ type: 'line', points: '[[0,0],[1000000,-1000000]]' });
    });

    test('keeps a linear element with one non-finite point by dropping just that point', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'l', { type: 'line', index: 'a0', points: '[[0,0],[1e400,0],[40,10]]' });
        });
        const [el] = readVectorFromDoc(doc).elements;
        expect(el).toMatchObject({ type: 'line', points: '[[0,0],[40,10]]' });
    });

    test('accepts the new zigzag fill style', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'r', { type: 'rectangle', index: 'a0', fillStyle: 'zigzag' });
        });
        expect(readVectorFromDoc(doc).elements[0]).toMatchObject({ fillStyle: 'zigzag' });
    });

    test('keeps a single-point linear element (a dot)', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'dot', { type: 'freedraw', index: 'a0', points: '[[0,0]]' });
        });
        expect(readVectorFromDoc(doc).elements[0]).toMatchObject({ type: 'freedraw', points: '[[0,0]]' });
    });

    test('strips XML-invalid control chars from text and fontFamily (keeps tab/newline)', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 't', {
                type: 'text',
                index: 'a0',
                text: `a\u0000b\u0007c\td\ne`,
                fontFamily: `Ex\u001Fcalifont`,
            });
        });
        // U+0000/U+0007/U+001F stripped; the tab and newline survive.
        expect(readVectorFromDoc(doc).elements[0]).toMatchObject({ text: 'abc\td\ne', fontFamily: 'Excalifont' });
    });

    test('materializes an arrow: heads, canonical bindings, and label fields', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'rect', { type: 'rectangle', index: 'a0' });
            writeElement(elements, 'ar', {
                type: 'arrow',
                index: 'a1',
                points: '[[0,0],[100,0]]',
                startArrowhead: 'circle',
                endArrowhead: 'triangle',
                // a valid binding to the present rectangle survives; extra keys are dropped on re-serialize
                startBinding: '{"elementId":"rect","fixedPoint":[0.5,1],"junk":9}',
                text: 'hi\nthere',
                fontSize: 18,
                fontFamily: 'Inter',
                labelWidth: 42,
            });
        });
        const arrow = readVectorFromDoc(doc).elements.find((e) => e.id === 'ar');
        expect(arrow).toMatchObject({
            type: 'arrow',
            startArrowhead: 'circle',
            endArrowhead: 'triangle',
            startBinding: '{"elementId":"rect","fixedPoint":[0.5,1]}',
            endBinding: '',
            text: 'hi\nthere',
            fontSize: 18,
            fontFamily: 'Inter',
            labelWidth: 42,
        });
    });

    test('falls back invalid heads and a malformed binding, and floors labelWidth at 0', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'ar', {
                type: 'arrow',
                index: 'a0',
                points: '[[0,0],[50,0]]',
                startArrowhead: 'spiral',
                endArrowhead: 42,
                startBinding: 'not json',
                endBinding: '{"fixedPoint":[0,0]}',
                labelWidth: -5,
            });
        });
        expect(readVectorFromDoc(doc).elements[0]).toMatchObject({
            startArrowhead: 'none',
            endArrowhead: 'arrow',
            startBinding: '',
            endBinding: '',
            labelWidth: 0,
        });
    });

    test('caps a hostile labelWidth at MAX_COORD (protects the shared viewBox)', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'ar', { type: 'arrow', index: 'a0', points: '[[0,0],[50,0]]', labelWidth: 1e9 });
        });
        expect(readVectorFromDoc(doc).elements[0]).toMatchObject({ labelWidth: 1_000_000 });
    });

    test('clamps a hostile fontSize (a label height derives from it, like labelWidth)', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'ar', {
                type: 'arrow',
                index: 'a0',
                points: '[[0,0],[50,0]]',
                text: 'x',
                fontSize: 1e12,
            });
            writeElement(elements, 'txt', { type: 'text', index: 'a1', text: 'x', fontSize: 0.001 });
        });
        const [ar, txt] = readVectorFromDoc(doc).elements;
        expect(ar).toMatchObject({ fontSize: 400 });
        expect(txt).toMatchObject({ fontSize: 4 });
    });

    test('clears a binding whose target is absent or not bindable (doc untouched)', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'txt', { type: 'text', index: 'a0', text: 'x' });
            writeElement(elements, 'ar', {
                type: 'arrow',
                index: 'a1',
                points: '[[0,0],[100,0]]',
                // start → a shape that never existed; end → a text element (not bindable)
                startBinding: '{"elementId":"ghost","fixedPoint":[0.5,0.5]}',
                endBinding: '{"elementId":"txt","fixedPoint":[0,0]}',
            });
        });
        const arrow = readVectorFromDoc(doc).elements.find((e) => e.id === 'ar');
        expect(arrow).toMatchObject({ startBinding: '', endBinding: '' });
        // the doc itself is left alone — nothing is written during a read
        expect((doc.getMap('elements').get('ar') as Y.Map<unknown>).get('startBinding')).toBe(
            '{"elementId":"ghost","fixedPoint":[0.5,0.5]}',
        );
    });

    test('skips an arrow whose points are missing or empty', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'ok', { type: 'arrow', index: 'a0', points: '[[0,0],[10,0]]' });
            writeElement(elements, 'missing', { type: 'arrow', index: 'a1' });
            writeElement(elements, 'empty', { type: 'arrow', index: 'a2', points: '[]' });
        });
        expect(readVectorFromDoc(doc).elements.map((e) => e.id)).toEqual(['ok']);
    });

    test('accepts only hex / transparent colours; anything else falls back (blocks url() smuggling)', () => {
        const doc = docWith((elements, meta) => {
            meta.set('background', 'url(#evil)');
            writeElement(elements, 'a', {
                type: 'rectangle',
                index: 'a0',
                strokeColor: '#abc',
                backgroundColor: 'url(http://x/y.svg)',
            });
            writeElement(elements, 'b', { type: 'rectangle', index: 'a1', strokeColor: 'red' });
        });
        const scene = readVectorFromDoc(doc);
        expect(scene.meta.background).toBe(DEFAULT_SCENE_META.background);
        expect(scene.elements[0]).toMatchObject({
            strokeColor: '#abc',
            backgroundColor: DEFAULT_ELEMENT_PROPS.backgroundColor,
        });
        expect(scene.elements[1].strokeColor).toBe(DEFAULT_ELEMENT_PROPS.strokeColor);
    });
});

describe('readVectorFromDoc — ELEMENT_FIELDS drift guard', () => {
    // Distinctive, non-default values so a field dropped from the per-field materializer surfaces
    // as a fallback mismatch rather than a coincidental pass.
    const rect: Record<string, unknown> = {
        id: 'rect1',
        type: 'rectangle',
        x: 11,
        y: 22,
        width: 33,
        height: 44,
        angle: 55,
        strokeColor: '#abcdef',
        backgroundColor: '#123456',
        fillStyle: 'cross-hatch',
        strokeWidth: 7,
        strokeStyle: 'dashed',
        roughness: 3,
        seed: 999,
        opacity: 42,
        locked: true,
        index: 'a1',
        roundness: 'sharp',
    };
    const text: Record<string, unknown> = {
        id: 'text1',
        type: 'text',
        x: 1,
        y: 2,
        width: 3,
        height: 4,
        angle: 6,
        strokeColor: '#0a0b0c',
        backgroundColor: '#0d0e0f',
        fillStyle: 'hachure',
        strokeWidth: 5,
        strokeStyle: 'dotted',
        roughness: 2,
        seed: 111,
        opacity: 88,
        locked: false,
        index: 'a1',
        text: 'hello',
        fontSize: 30,
        fontFamily: 'Inter',
        textAlign: 'center',
    };
    const image: Record<string, unknown> = {
        id: 'img1',
        type: 'image',
        x: 9,
        y: 8,
        width: 7,
        height: 6,
        angle: 5,
        strokeColor: '#ffffff',
        backgroundColor: '#000000',
        fillStyle: 'solid',
        strokeWidth: 4,
        strokeStyle: 'solid',
        roughness: 1,
        seed: 222,
        opacity: 100,
        locked: true,
        index: 'a1',
        mediaName: 'photo.png',
    };
    const line: Record<string, unknown> = {
        id: 'line1',
        type: 'line',
        x: 3,
        y: 4,
        width: 80,
        height: 15,
        angle: 12,
        strokeColor: '#334455',
        backgroundColor: '#667788',
        fillStyle: 'zigzag',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 0,
        seed: 333,
        opacity: 60,
        locked: false,
        index: 'a1',
        roundness: 'round',
        points: '[[0,0],[80,10],[40,-5]]',
    };

    const BASE_FIELDS = [
        'id',
        'type',
        'x',
        'y',
        'width',
        'height',
        'angle',
        'strokeColor',
        'backgroundColor',
        'fillStyle',
        'strokeWidth',
        'strokeStyle',
        'roughness',
        'seed',
        'opacity',
        'locked',
        'index',
    ];
    // Unbound (startBinding/endBinding '') so the single-element doc's dangling-binding pass is a no-op
    // and the values round-trip; real binding round-trips are covered by the dedicated arrow tests above.
    const arrow: Record<string, unknown> = {
        id: 'arrow1',
        type: 'arrow',
        x: 2,
        y: 3,
        width: 90,
        height: 20,
        // angle 0 because this is an elbow arrow (elbow: true) and the reader pins angle 0 for elbows;
        // non-zero angles are exercised by the rect/text/line drift cases.
        angle: 0,
        strokeColor: '#aabbcc',
        backgroundColor: '#ddeeff',
        fillStyle: 'solid',
        strokeWidth: 3,
        strokeStyle: 'dashed',
        roughness: 1,
        seed: 444,
        opacity: 75,
        locked: false,
        index: 'a1',
        roundness: 'sharp',
        points: '[[0,0],[90,20]]',
        startArrowhead: 'circle',
        endArrowhead: 'triangle',
        startBinding: '',
        endBinding: '',
        elbow: true,
        text: 'label',
        fontSize: 13,
        fontFamily: 'Inter',
        labelWidth: 77,
    };

    const cases = [
        { record: rect, fields: [...BASE_FIELDS, 'roundness'] },
        { record: text, fields: [...BASE_FIELDS, 'text', 'fontSize', 'fontFamily', 'textAlign'] },
        { record: image, fields: [...BASE_FIELDS, 'mediaName'] },
        { record: line, fields: [...BASE_FIELDS, 'roundness', 'points'] },
        {
            record: arrow,
            fields: [
                ...BASE_FIELDS,
                'roundness',
                'points',
                'startArrowhead',
                'endArrowhead',
                'startBinding',
                'endBinding',
                'elbow',
                'text',
                'fontSize',
                'fontFamily',
                'labelWidth',
            ],
        },
    ];

    test('the variant field map covers ELEMENT_FIELDS exactly', () => {
        // Adding a key to ELEMENT_FIELDS without listing it above fails here first, forcing the
        // round-trip below to also exercise the new field.
        const covered = [...new Set(cases.flatMap((c) => c.fields))].sort();
        expect(covered).toEqual([...ELEMENT_FIELDS].sort());
    });

    test('every ELEMENT_FIELDS key round-trips through readVectorFromDoc', () => {
        for (const { record, fields } of cases) {
            const doc = docWith((elements) => writeElement(elements, String(record.id), record));
            const [el] = readVectorFromDoc(doc).elements;
            const got: Record<string, unknown> = Object.fromEntries(Object.entries(el));
            for (const field of fields) {
                expect(got[field]).toEqual(record[field]);
            }
        }
    });
});
