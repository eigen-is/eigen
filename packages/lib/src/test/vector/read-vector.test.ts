import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { isValidFractionalIndex } from '../../vector/fractional-index';
import { ELEMENT_FIELDS } from '../../vector/kinds';
import { readVectorFromDoc } from '../../vector/read-vector';
import { DEFAULT_CORNERS, DEFAULT_ELEMENT_PROPS, DEFAULT_FONT_FAMILY, DEFAULT_SCENE_META } from '../../vector/types';

function writeElement(map: Y.Map<unknown>, id: string, fields: Record<string, unknown>) {
    const m = new Y.Map();
    m.set('id', id);
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    map.set(id, m);
}

function writeFrame(doc: Y.Doc, id: string, index = 'a0') {
    doc.transact(() => {
        const f = new Y.Map();
        f.set('id', id);
        f.set('index', index);
        doc.getMap('frames').set(id, f);
    });
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

    test('materializes richtext and image type-specific fields', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 't', {
                type: 'richtext',
                index: 'a0',
                html: '<p>hello</p>',
                fontSize: 24,
                fontFamily: 'Inter',
                textAlign: 'center',
            });
            writeElement(elements, 'i', { type: 'image', index: 'a1', mediaName: 'pic.png', objectFit: 'cover' });
        });
        const [richtext, image] = readVectorFromDoc(doc).elements;
        expect(richtext).toMatchObject({
            type: 'richtext',
            html: '<p>hello</p>',
            fontSize: 24,
            fontFamily: 'Inter',
            textAlign: 'center',
        });
        expect(image).toMatchObject({ type: 'image', mediaName: 'pic.png', objectFit: 'cover' });
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
                height: -50, // a size is floored at 0, never negative (invalid in SVG)
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

    test('materializes freedraw pen pressure, index-aligned with points; defaults simulate', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'pen', {
                type: 'freedraw',
                index: 'a0',
                points: '[[0,0],[10,5],[20,0]]',
                pressures: '[0.25,0.75,0.5]',
                simulatePressure: false,
            });
            // A legacy freedraw (no pressure fields) reads back as simulate with no pressures.
            writeElement(elements, 'old', { type: 'freedraw', index: 'a1', points: '[[0,0],[5,5]]' });
        });
        const [pen, old] = readVectorFromDoc(doc).elements;
        expect(pen).toMatchObject({
            type: 'freedraw',
            points: '[[0,0],[10,5],[20,0]]',
            pressures: '[0.25,0.75,0.5]',
            simulatePressure: false,
        });
        expect(old).toMatchObject({ type: 'freedraw', points: '[[0,0],[5,5]]', pressures: '', simulatePressure: true });
    });

    test('blanks pen pressures when their count drifts from the surviving points (alignment invariant)', () => {
        const doc = docWith((elements) => {
            // A non-finite point drops one survivor → 2 points but 3 pressures ⇒ misaligned ⇒ blank + simulate.
            writeElement(elements, 'pen', {
                type: 'freedraw',
                index: 'a0',
                points: '[[0,0],[1e400,0],[20,0]]',
                pressures: '[0.1,0.2,0.3]',
                simulatePressure: false,
            });
        });
        const [pen] = readVectorFromDoc(doc).elements;
        expect(pen).toMatchObject({
            type: 'freedraw',
            points: '[[0,0],[20,0]]',
            pressures: '',
            simulatePressure: true,
        });
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

    test('the hatch style rides the fill, and an unknown one degrades to the default', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'r', {
                type: 'rectangle',
                index: 'a0',
                fill: '{"type":"solid","color":"#ff0000","style":"zigzag"}',
            });
            writeElement(elements, 'r2', {
                type: 'rectangle',
                index: 'a1',
                fill: '{"type":"solid","color":"#ff0000","style":"tartan"}',
            });
        });
        const [zigzag, bogus] = readVectorFromDoc(doc).elements;
        expect(zigzag).toMatchObject({ fill: '{"type":"solid","color":"#ff0000","style":"zigzag"}' });
        expect(bogus).toMatchObject({ fill: '{"type":"solid","color":"#ff0000","style":"solid"}' });
    });

    test('keeps a single-point linear element (a dot)', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'dot', { type: 'freedraw', index: 'a0', points: '[[0,0]]' });
        });
        expect(readVectorFromDoc(doc).elements[0]).toMatchObject({ type: 'freedraw', points: '[[0,0]]' });
    });

    test('strips XML-invalid control chars from html and fontFamily (keeps tab/newline)', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 't', {
                type: 'richtext',
                index: 'a0',
                html: `a\u0000b\u0007c\td\ne`,
                fontFamily: `Ex\u001Fcalifont`,
            });
        });
        // U+0000/U+0007/U+001F stripped; the tab and newline survive.
        expect(readVectorFromDoc(doc).elements[0]).toMatchObject({ html: 'abc\td\ne', fontFamily: 'Excalifont' });
    });

    test('caps html at 64 KiB, truncating on a code-point boundary', () => {
        const doc = docWith((elements) => {
            // 3-byte characters, so the cap lands mid-character and must step back.
            writeElement(elements, 't', { type: 'richtext', index: 'a0', html: '☃'.repeat(30_000) });
        });
        const [el] = readVectorFromDoc(doc).elements;
        const html = el.type === 'richtext' ? el.html : '';
        expect(new TextEncoder().encode(html).length).toBeLessThanOrEqual(64 * 1024);
        expect(html).toBe('☃'.repeat(Math.floor((64 * 1024) / 3)));
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
            writeElement(elements, 'txt', { type: 'richtext', index: 'a1', html: 'x', fontSize: 0.001 });
        });
        const [ar, txt] = readVectorFromDoc(doc).elements;
        expect(ar).toMatchObject({ fontSize: 400 });
        expect(txt).toMatchObject({ fontSize: 4 });
    });

    test('clamps richtext padding to the box range', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'ok', { type: 'richtext', index: 'a0', html: 'x', padding: 12 });
            writeElement(elements, 'neg', { type: 'richtext', index: 'a1', html: 'x', padding: -5 });
            writeElement(elements, 'huge', { type: 'richtext', index: 'a2', html: 'x', padding: 1e9 });
        });
        const padding = readVectorFromDoc(doc).elements.map((el) => el.type === 'richtext' && el.padding);
        expect(padding).toEqual([12, 0, 200]);
    });

    test('clamps richtext letter-spacing and line-height to their layout ranges', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'ok', {
                type: 'richtext',
                index: 'a0',
                html: 'x',
                letterSpacing: 12,
                lineHeight: 2,
            });
            writeElement(elements, 'low', {
                type: 'richtext',
                index: 'a1',
                html: 'x',
                letterSpacing: -1e9,
                lineHeight: 0,
            });
            writeElement(elements, 'high', {
                type: 'richtext',
                index: 'a2',
                html: 'x',
                letterSpacing: 1e9,
                lineHeight: 1e9,
            });
        });
        const spacing = readVectorFromDoc(doc).elements.map((el) => el.type === 'richtext' && el.letterSpacing);
        const leading = readVectorFromDoc(doc).elements.map((el) => el.type === 'richtext' && el.lineHeight);
        expect(spacing).toEqual([12, -200, 200]);
        expect(leading).toEqual([2, 0.5, 10]);
    });

    test('a fontFamily outside the font registry falls back, so it can never carry CSS', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'ok', { type: 'richtext', index: 'a0', html: 'x', fontFamily: 'Inter' });
            writeElement(elements, 'evil', {
                type: 'richtext',
                index: 'a1',
                html: 'x',
                fontFamily: "x', sans-serif; background:url(https://attacker.example/p)",
            });
            writeElement(elements, 'arrow', {
                type: 'arrow',
                index: 'a2',
                points: '[[0,0],[10,0]]',
                text: 'label',
                fontFamily: 'Comic Sans; color:red',
            });
        });
        const fonts = readVectorFromDoc(doc).elements.map((el) => 'fontFamily' in el && el.fontFamily);
        expect(fonts).toEqual(['Inter', DEFAULT_FONT_FAMILY, DEFAULT_FONT_FAMILY]);
    });

    test('clamps the roughjs inputs a corrupt write could poison', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'neg', {
                type: 'rectangle',
                index: 'a0',
                strokeWidth: -4,
                roughness: -2,
                seed: -1,
            });
            writeElement(elements, 'huge', {
                type: 'rectangle',
                index: 'a1',
                strokeWidth: 1e9,
                roughness: 1e9,
                seed: 1e300,
            });
        });
        const [neg, huge] = readVectorFromDoc(doc).elements;
        expect(neg).toMatchObject({ strokeWidth: 0 });
        expect(huge).toMatchObject({ strokeWidth: 100 });
        expect(neg.type === 'rectangle' && [neg.roughness, neg.seed]).toEqual([0, 0]);
        expect(huge.type === 'rectangle' && [huge.roughness, huge.seed]).toEqual([10, 2 ** 31]);
    });

    test('clears a binding whose target is absent or not bindable (doc untouched)', () => {
        const doc = docWith((elements) => {
            writeElement(elements, 'txt', { type: 'richtext', index: 'a0', html: 'x' });
            writeElement(elements, 'ar', {
                type: 'arrow',
                index: 'a1',
                points: '[[0,0],[100,0]]',
                // start → a shape that never existed; end → a rich-text element (not bindable)
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
                fill: '{"type":"solid","color":"url(http://x/y.svg)"}',
            });
            writeElement(elements, 'b', { type: 'rectangle', index: 'a1', strokeColor: 'red' });
        });
        const scene = readVectorFromDoc(doc);
        expect(scene.meta.background).toBe(DEFAULT_SCENE_META.background);
        expect(scene.elements[0]).toMatchObject({
            strokeColor: '#abc',
            fill: '{"type":"solid","color":"transparent","style":"solid"}',
        });
        expect(scene.elements[1].strokeColor).toBe(DEFAULT_ELEMENT_PROPS.strokeColor);
    });
});

describe('readVectorFromDoc — ELEMENT_FIELDS drift guard', () => {
    // Distinctive, non-default values so a field dropped from the per-field materializer surfaces
    // as a fallback mismatch rather than a coincidental pass. Every value is already canonical (fills
    // and id lists re-serialize on read), so a round-trip compares equal.
    const BASE_FIELDS = [
        'id',
        'type',
        'x',
        'y',
        'width',
        'height',
        'angle',
        'index',
        'frameId',
        'commentCardIds',
        'opacity',
        'locked',
        'strokeColor',
        'strokeWidth',
        'strokeStyle',
    ];
    const PAINT_FIELDS = ['fill'];
    const SKETCH_FIELDS = ['roughness', 'seed'];

    const base = (over: Record<string, unknown>): Record<string, unknown> => ({
        x: 11,
        y: 22,
        width: 33,
        height: 44,
        angle: 55,
        index: 'a1',
        frameId: 'frame1',
        commentCardIds: '["card1","card2"]',
        opacity: 42,
        locked: true,
        strokeColor: '#abcdef',
        strokeWidth: 7,
        strokeStyle: 'dashed',
        ...over,
    });

    const paint = { fill: '{"type":"solid","color":"#123456","style":"cross-hatch"}' };
    const sketch = { roughness: 3, seed: 999 };

    const rect = base({ id: 'rect1', type: 'rectangle', ...paint, ...sketch, corners: 'round' });
    const richtext = base({
        id: 'rich1',
        type: 'richtext',
        fill: paint.fill,
        html: '<p>hello</p>',
        corners: 'straight',
        fontFamily: 'Inter',
        fontSize: 30,
        fontWeight: 'bold',
        fontStyle: 'italic',
        textDecoration: 'underline',
        textAlign: 'justify',
        verticalAlign: 'bottom',
        color: '#0a0b0c',
        letterSpacing: 2,
        lineHeight: 1.5,
        padding: 16,
    });
    const image = base({ id: 'img1', type: 'image', mediaName: 'photo.png', corners: 'curved', objectFit: 'cover' });
    const line = base({
        id: 'line1',
        type: 'line',
        ...paint,
        ...sketch,
        fill: '{"type":"solid","color":"#123456","style":"zigzag"}',
        roundness: 'round',
        points: '[[0,0],[80,10],[40,-5]]',
    });
    // freedraw carries the pen-pressure fields (index-aligned with points) on top of the linear fields.
    const freedraw = base({
        id: 'freedraw1',
        type: 'freedraw',
        ...paint,
        ...sketch,
        roundness: 'sharp',
        points: '[[0,0],[20,10],[40,0]]',
        pressures: '[0.25,0.75,0.5]',
        simulatePressure: false,
    });
    // Unbound (startBinding/endBinding '') so the single-element doc's dangling-binding pass is a no-op
    // and the values round-trip; real binding round-trips are covered by the dedicated arrow tests above.
    // angle 0 because this is an elbow arrow and the reader pins angle 0 for elbows.
    const arrow = base({
        id: 'arrow1',
        type: 'arrow',
        ...sketch,
        angle: 0,
        roundness: 'sharp',
        points: '[[0,0],[45,0],[45,20],[90,20]]',
        startArrowhead: 'circle',
        endArrowhead: 'triangle',
        startBinding: '',
        endBinding: '',
        elbow: true,
        fixedSegments:
            '{"segments":[{"index":2,"start":[45,0],"end":[45,20]}],"startIsSpecial":false,"endIsSpecial":false}',
        text: 'label',
        fontSize: 13,
        fontFamily: 'Inter',
        labelWidth: 77,
    });

    const cases = [
        { record: rect, fields: [...BASE_FIELDS, ...PAINT_FIELDS, ...SKETCH_FIELDS, 'corners'] },
        {
            record: richtext,
            fields: [
                ...BASE_FIELDS,
                'fill',
                'html',
                'corners',
                'fontFamily',
                'fontSize',
                'fontWeight',
                'fontStyle',
                'textDecoration',
                'textAlign',
                'verticalAlign',
                'color',
                'letterSpacing',
                'lineHeight',
                'padding',
            ],
        },
        { record: image, fields: [...BASE_FIELDS, 'mediaName', 'corners', 'objectFit'] },
        { record: line, fields: [...BASE_FIELDS, ...PAINT_FIELDS, ...SKETCH_FIELDS, 'roundness', 'points'] },
        {
            record: freedraw,
            fields: [
                ...BASE_FIELDS,
                ...PAINT_FIELDS,
                ...SKETCH_FIELDS,
                'roundness',
                'points',
                'pressures',
                'simulatePressure',
            ],
        },
        {
            record: arrow,
            fields: [
                ...BASE_FIELDS,
                ...SKETCH_FIELDS,
                'roundness',
                'points',
                'startArrowhead',
                'endArrowhead',
                'startBinding',
                'endBinding',
                'elbow',
                'fixedSegments',
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
            // every fixture sits in 'frame1'; without the frame the reader re-homes the dangling frameId
            writeFrame(doc, 'frame1');
            const [el] = readVectorFromDoc(doc).elements;
            const got: Record<string, unknown> = Object.fromEntries(Object.entries(el));
            for (const field of fields) {
                expect(got[field]).toEqual(record[field]);
            }
        }
    });
});

describe('readVectorFromDoc — rich text', () => {
    // There is no per-box marker colour: it is redundant with the box `fill`, and a real highlight is a
    // TipTap mark inside `html`. A value left in a document written by an older build is dropped.
    test('a stored highlightColor is not read back onto the element', () => {
        const doc = docWith((elements) =>
            writeElement(elements, 'rich1', { type: 'richtext', html: '<p>hi</p>', highlightColor: '#ffff00' }),
        );
        const [el] = readVectorFromDoc(doc).elements;
        expect(el).not.toHaveProperty('highlightColor');
    });
});

describe('readVectorFromDoc — pinned elbow validation', () => {
    const arrowFields = (over: Record<string, unknown>) => ({
        type: 'arrow',
        elbow: true,
        x: 0,
        y: 0,
        ...over,
    });

    test('a valid pinned polyline round-trips its pins (index rebuilt from the polyline)', () => {
        const doc = docWith((elements) =>
            writeElement(
                elements,
                'ar',
                arrowFields({
                    points: '[[0,0],[40,0],[40,60],[80,60]]',
                    fixedSegments:
                        '{"segments":[{"index":2,"start":[40,0],"end":[40,60]}],"startIsSpecial":false,"endIsSpecial":false}',
                }),
            ),
        );
        const [el] = readVectorFromDoc(doc).elements;
        expect(el.type === 'arrow' && el.fixedSegments).toBe(
            '{"segments":[{"index":2,"start":[40,0],"end":[40,60]}],"startIsSpecial":false,"endIsSpecial":false}',
        );
    });

    test('pins are DROPPED (arrow stays a derived elbow) when the polyline is too short for them', () => {
        const doc = docWith((elements) =>
            writeElement(
                elements,
                'ar',
                // Only two points — no interior segment can carry a pin.
                arrowFields({
                    points: '[[0,0],[80,60]]',
                    fixedSegments: '{"segments":[{"index":2,"start":[40,0],"end":[40,60]}]}',
                }),
            ),
        );
        const [el] = readVectorFromDoc(doc).elements;
        expect(el.type === 'arrow' && el.fixedSegments).toBe('');
    });

    test('an out-of-range / first-or-last index is dropped', () => {
        const doc = docWith((elements) =>
            writeElement(
                elements,
                'ar',
                arrowFields({
                    points: '[[0,0],[40,0],[40,60],[80,60]]',
                    // index 3 is the LAST segment (points[2]→points[3]) — unfixable.
                    fixedSegments: '{"segments":[{"index":3,"start":[40,60],"end":[80,60]}]}',
                }),
            ),
        );
        const [el] = readVectorFromDoc(doc).elements;
        expect(el.type === 'arrow' && el.fixedSegments).toBe('');
    });
});

describe('readVectorFromDoc — the canvas model', () => {
    test('materializes the new base fields, a richtext element and the frames root', () => {
        const doc = new Y.Doc();
        doc.transact(() => {
            const frames = doc.getMap('frames');
            const f = new Y.Map();
            f.set('id', 'f1');
            f.set('index', 'a0');
            f.set('name', 'Cover');
            f.set('background', '{"type":"solid","color":"#ffffff"}');
            frames.set('f1', f);
            writeElement(doc.getMap('elements'), 'r', {
                type: 'richtext',
                index: 'a0',
                frameId: 'f1',
                commentCardIds: '["c1","c2"]',
                html: '<p>hello</p>',
                fill: '{"type":"gradient","from":"#000000","to":"#ffffff","angle":45}',
                corners: 'round',
                verticalAlign: 'center',
            });
        });
        const scene = readVectorFromDoc(doc);
        expect(scene.frames).toEqual([
            {
                id: 'f1',
                index: 'a0',
                name: 'Cover',
                width: 1920,
                height: 1080,
                background: '{"type":"solid","color":"#ffffff"}',
            },
        ]);
        expect(scene.elements[0]).toMatchObject({
            type: 'richtext',
            frameId: 'f1',
            commentCardIds: '["c1","c2"]',
            html: '<p>hello</p>',
            corners: 'round',
            verticalAlign: 'center',
        });
    });

    test('a frameId whose frame is gone re-homes to the lowest-index frame', () => {
        const doc = new Y.Doc();
        doc.transact(() => {
            writeElement(doc.getMap('elements'), 'a', { type: 'rectangle', index: 'a0', frameId: 'ghost' });
            writeElement(doc.getMap('elements'), 'b', { type: 'rectangle', index: 'a1', frameId: 'f2' });
        });
        writeFrame(doc, 'f2', 'a1');
        writeFrame(doc, 'f1', 'a0');
        const [a, b] = readVectorFromDoc(doc).elements;
        expect(a.frameId).toBe('f1');
        expect(b.frameId).toBe('f2');
        // the doc itself is left alone — the next real write of the element is what persists the re-home
        const stored = doc.getMap('elements').get('a');
        expect(stored instanceof Y.Map && stored.get('frameId')).toBe('ghost');
    });

    test('with no frames at all a dangling frameId falls back to the infinite canvas', () => {
        const doc = new Y.Doc();
        doc.transact(() =>
            writeElement(doc.getMap('elements'), 'a', { type: 'rectangle', index: 'a0', frameId: 'ghost' }),
        );
        expect(readVectorFromDoc(doc).elements[0].frameId).toBe('');
    });

    test('the hand text kind no longer exists', () => {
        const doc = new Y.Doc();
        doc.transact(() => writeElement(doc.getMap('elements'), 't', { type: 'text', index: 'a0', text: 'x' }));
        expect(readVectorFromDoc(doc).elements).toEqual([]);
    });

    test('an unparseable fill reads back as the transparent solid fill', () => {
        const doc = new Y.Doc();
        doc.transact(() => writeElement(doc.getMap('elements'), 'r', { type: 'rectangle', index: 'a0', fill: 'nope' }));
        expect(readVectorFromDoc(doc).elements[0]).toMatchObject({
            fill: '{"type":"solid","color":"transparent","style":"solid"}',
        });
    });

    test('corners falls back to the shape default and only accepts the vocabulary', () => {
        const doc = new Y.Doc();
        doc.transact(() => {
            writeElement(doc.getMap('elements'), 'a', { type: 'rectangle', index: 'a0', corners: 'sharp' });
            writeElement(doc.getMap('elements'), 'b', { type: 'diamond', index: 'a1', corners: 'straight' });
        });
        const [a, b] = readVectorFromDoc(doc).elements;
        expect(a).toMatchObject({ corners: DEFAULT_CORNERS });
        expect(b).toMatchObject({ corners: 'straight' });
    });
});
