import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { DEFAULT_FRAME_BACKGROUND, SLIDE_SIZES } from '../../vector/frames';
import { ELEMENT_KINDS, SLIDES_STYLE_DEFAULTS, VECTOR_STYLE_DEFAULTS } from '../../vector/kinds';
import { readVectorFromDoc } from '../../vector/read-vector';
import { serializeBinding } from '../../vector/types';
import {
    frameKeysAfter,
    newElementId,
    newFrameId,
    randomSeed,
    topmostIndex,
    writeElementInDoc,
    writeFrameInDoc,
} from '../../vector/write-vector';
import { arrow, chart, ellipse, image, linear, pie, richtext, shape } from './element-factories';

// Every kind a slide holds, each at its own index so the reader returns them in this order.
const RECT = shape({ id: 'r', type: 'rectangle', index: 'a0', x: 10, y: 20, seed: 11 });
const SLIDE_KINDS = [
    RECT,
    ellipse({ id: 'e', index: 'a1', seed: 12, html: '<p>Label</p>' }),
    shape({ id: 'd', type: 'diamond', index: 'a2', seed: 13 }),
    pie({ id: 'p', index: 'a3', startAngle: 30, sweepAngle: 120 }),
    linear({ id: 'l', type: 'line', index: 'a4', roundness: 'round' }),
    arrow({
        id: 'ar',
        index: 'a5',
        startBinding: serializeBinding({ elementId: 'r', fixedPoint: [1, 0.5] }),
        endBinding: serializeBinding({ elementId: 'e', fixedPoint: [0, 0.5] }),
    }),
    image({ id: 'i', index: 'a6', mediaName: 'photo.png' }),
    richtext({ id: 't', index: 'a7', html: '<p>Title</p>', fontSize: 64 }),
    chart({ id: 'c', index: 'a8' }),
];

describe('writeElementInDoc', () => {
    test('every kind a slide holds reads back as written, bindings included', () => {
        const doc = new Y.Doc();
        for (const el of SLIDE_KINDS) writeElementInDoc(doc, el, el.index, VECTOR_STYLE_DEFAULTS, el.id);
        expect(readVectorFromDoc(doc).elements).toEqual(SLIDE_KINDS);
    });

    test('a bare partial gets the kind defaults under the host style table', () => {
        const doc = new Y.Doc();
        const id = writeElementInDoc(doc, { type: 'rectangle' }, 'a0', SLIDES_STYLE_DEFAULTS);
        // The stored record, not the read: the reader would fill a missing field with its own fallback.
        const stored = doc.getMap('elements').get(id);
        expect(stored instanceof Y.Map && stored.toJSON()).toMatchObject({
            id,
            type: 'rectangle',
            roughness: SLIDES_STYLE_DEFAULTS.roughness,
            ...ELEMENT_KINDS.rectangle.defaults(SLIDES_STYLE_DEFAULTS),
        });
    });

    test("a new shape stores all twelve text keys, in the host's font, size and color, centered and inset", () => {
        for (const [style, host] of [
            [VECTOR_STYLE_DEFAULTS, { fontFamily: 'Excalifont', fontSize: 20, color: '#1e1e1e' }],
            [SLIDES_STYLE_DEFAULTS, { fontFamily: 'Inter', fontSize: 48, color: '#000000' }],
        ] as const) {
            for (const type of ['rectangle', 'diamond', 'ellipse', 'pie', 'path'] as const) {
                const doc = new Y.Doc();
                const id = writeElementInDoc(doc, { type }, 'a0', style);
                const stored = doc.getMap('elements').get(id);
                const json = stored instanceof Y.Map ? stored.toJSON() : {};
                const text = Object.fromEntries(
                    [
                        'html',
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
                    ].map((key) => [key, json[key]]),
                );
                expect([type, text]).toEqual([
                    type,
                    {
                        html: '',
                        ...host,
                        fontWeight: 'normal',
                        fontStyle: 'normal',
                        textDecoration: 'none',
                        textAlign: 'center',
                        verticalAlign: 'center',
                        letterSpacing: 0,
                        lineHeight: 1.2,
                        padding: 10,
                    },
                ]);
            }
        }
    });

    test('honors a caller-supplied seed and id, and draws fresh ones otherwise', () => {
        const doc = new Y.Doc();
        const fixed = writeElementInDoc(doc, { type: 'ellipse', seed: 42 }, 'a0', VECTOR_STYLE_DEFAULTS, 'el-fixed');
        const fresh = writeElementInDoc(doc, { type: 'ellipse' }, 'a1', VECTOR_STYLE_DEFAULTS);
        expect(fixed).toBe('el-fixed');
        expect(fresh).toStartWith('el-');
        const [a, b] = readVectorFromDoc(doc).elements;
        expect(a).toMatchObject({ id: 'el-fixed', seed: 42 });
        expect(b.id).toBe(fresh);
        expect(b.seed).toBeGreaterThanOrEqual(1);
    });

    test('nested in a transact it joins that one, so its origin and single update survive', () => {
        const doc = new Y.Doc();
        const origin = Symbol('caller');
        const origins: unknown[] = [];
        doc.on('afterTransaction', (tr) => origins.push(tr.origin));
        doc.transact(() => {
            writeFrameInDoc(doc, { id: 'f', index: 'a0' });
            writeElementInDoc(doc, { type: 'rectangle', frameId: 'f' }, 'a0', SLIDES_STYLE_DEFAULTS);
        }, origin);
        expect(origins).toEqual([origin]);
    });
});

describe('writeFrameInDoc', () => {
    test("a frame reads back with its name and background at the deck's slide size", () => {
        const doc = new Y.Doc();
        writeFrameInDoc(doc, { id: 'f1', index: 'a0', name: 'Intro', background: '' });
        writeFrameInDoc(doc, { id: 'f2', index: 'a1' });
        expect(readVectorFromDoc(doc).frames).toEqual([
            { id: 'f1', index: 'a0', name: 'Intro', ...SLIDE_SIZES['16:9'], background: '' },
            { id: 'f2', index: 'a1', name: '', ...SLIDE_SIZES['16:9'], background: DEFAULT_FRAME_BACKGROUND },
        ]);
    });

    test("never stores the size, which is the deck's", () => {
        const doc = new Y.Doc();
        writeFrameInDoc(doc, { id: 'f', index: 'a0', width: 800, height: 600 });
        const stored = doc.getMap('frames').get('f');
        expect(stored instanceof Y.Map && [...stored.keys()].sort()).toEqual(['background', 'id', 'index', 'name']);
    });
});

describe('topmostIndex', () => {
    test('the highest valid index, skipping malformed entries', () => {
        const doc = new Y.Doc();
        writeElementInDoc(doc, { type: 'rectangle' }, 'a3', VECTOR_STYLE_DEFAULTS);
        writeElementInDoc(doc, { type: 'rectangle' }, 'a1', VECTOR_STYLE_DEFAULTS);
        const map = doc.getMap('elements');
        doc.transact(() => {
            const bad = new Y.Map();
            bad.set('index', 'not an index');
            map.set('bad', bad);
            map.set('scalar', 'zz');
        });
        expect(topmostIndex(map)).toBe('a3');
        expect(topmostIndex(new Y.Doc().getMap('elements'))).toBeNull();
    });
});

// Two peers each adding a slide after one slide at once write one key twice.
describe('frameKeysAfter', () => {
    test('after either of two frames sharing a key, the keys land above both, whatever order the map holds them in', () => {
        const keysAfter = (ids: string[]) => {
            const doc = new Y.Doc();
            for (const id of ids) writeFrameInDoc(doc, { id, index: 'a1' });
            writeFrameInDoc(doc, { id: 'fr-c', index: 'a2' });
            const frames = doc.getMap('frames');
            return ['fr-a', 'fr-b'].map((after) => frameKeysAfter(frames, after, 2));
        };
        const keys = keysAfter(['fr-a', 'fr-b']);
        expect(keysAfter(['fr-b', 'fr-a'])).toEqual(keys);
        for (const [first, second] of keys) expect('a1' < first && first < second && second < 'a2').toBe(true);
    });
});

describe('ids and seeds', () => {
    test('fresh ids carry their prefix and never repeat; seeds stay in the reader range', () => {
        expect(newElementId()).toStartWith('el-');
        expect(newFrameId()).toStartWith('fr-');
        expect(newElementId()).not.toBe(newElementId());
        for (let i = 0; i < 100; i++) {
            const seed = randomSeed();
            expect(Number.isInteger(seed) && seed >= 1 && seed < 2 ** 31).toBe(true);
        }
    });
});
