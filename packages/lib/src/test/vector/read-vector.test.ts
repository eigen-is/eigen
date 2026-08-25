import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { isValidFractionalIndex } from '../../vector/fractional-index';
import { readVectorFromDoc } from '../../vector/read-vector';
import { DEFAULT_ELEMENT_PROPS, ELEMENT_FIELDS } from '../../vector/types';

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
    const cases = [
        { record: rect, fields: [...BASE_FIELDS, 'roundness'] },
        { record: text, fields: [...BASE_FIELDS, 'text', 'fontSize', 'fontFamily', 'textAlign'] },
        { record: image, fields: [...BASE_FIELDS, 'mediaName'] },
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
