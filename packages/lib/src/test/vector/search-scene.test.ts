import { describe, expect, test } from 'bun:test';
import type { VectorFrame } from '../../vector/frames';
import { SLIDE_SIZES } from '../../vector/frames';
import { readElementFromFields } from '../../vector/read-vector';
import { searchScene } from '../../vector/search-scene';
import type { VectorScene } from '../../vector/types';
import { arrow, ellipse, path, pie, richtext, scene, shape } from './element-factories';

const frame = (id: string, index: string): VectorFrame => ({
    id,
    index,
    name: id,
    ...SLIDE_SIZES['16:9'],
    background: '',
});

const framed = (elements: VectorScene['elements'], frames: VectorFrame[]): VectorScene => ({
    ...scene(elements),
    frames,
});

describe('searchScene', () => {
    test('finds rich text with its tags stripped', () => {
        const matches = searchScene(
            scene([richtext({ id: 'a', html: '<p>Total <strong>budget</strong></p>' })]),
            /budget/gi,
        );
        expect(matches.map((m) => m.id)).toEqual(['a']);
        expect(matches[0].label).toBe('Total budget');
    });

    test('finds an arrow label', () => {
        expect(
            searchScene(
                scene([arrow({ id: 'arr', text: 'depends on', height: 0, points: '[[0,0],[100,0]]' })]),
                /depends/gi,
            ).map((m) => m.id),
        ).toEqual(['arr']);
    });

    test('a match id is the element id — self-describing, resolvable without a cached search', () => {
        expect(searchScene(scene([richtext({ id: 'el-9', html: '<p>hit</p>' })]), /hit/gi)[0].id).toBe('el-9');
    });

    test('finds the text in a shape, in reading order among the text boxes', () => {
        const doc = scene([
            richtext({ id: 'box', index: 'a2', html: '<p>plan</p>' }),
            shape({ id: 'rect', type: 'rectangle', index: 'a0', html: '<p>the <em>plan</em></p>' }),
            pie({ id: 'pie', index: 'a4', html: '<p>plan</p>' }),
            ellipse({ id: 'ellipse', index: 'a1', html: '<p>plan</p>' }),
            shape({ id: 'diamond', type: 'diamond', index: 'a3', html: '<p>plan</p>' }),
            path({ id: 'path', index: 'a5', html: '<p>plan</p>' }),
        ]);
        const matches = searchScene(doc, /plan/gi);
        expect(matches.map((m) => m.id)).toEqual(['rect', 'ellipse', 'box', 'diamond', 'pie', 'path']);
        expect(matches[0].label).toBe('the plan');
    });

    test("an open path's stored text is not found", () => {
        const stored = { ...path({ id: 'o', path: 'M 0 0 L 1 1', closed: false }), html: '<p>plan</p>' };
        const el = readElementFromFields(new Map(Object.entries(stored)));
        expect(el?.type).toBe('path');
        expect(searchScene(scene(el ? [el] : []), /plan/gi)).toEqual([]);
    });

    test('kinds with no text never match', () => {
        expect(searchScene(scene([shape({ id: 'r', type: 'rectangle' })]), /./gi)).toEqual([]);
    });

    test('an element whose text does not match is skipped', () => {
        expect(searchScene(scene([richtext({ id: 'a', html: '<p>hello</p>' })]), /goodbye/gi)).toEqual([]);
    });

    test('results are ordered by frame, then z-order', () => {
        const doc = framed(
            [
                richtext({ id: 'b', index: 'a1', frameId: 'f2', html: '<p>x</p>' }),
                richtext({ id: 'a', index: 'a0', frameId: 'f2', html: '<p>x</p>' }),
                richtext({ id: 'c', index: 'a0', frameId: 'f1', html: '<p>x</p>' }),
            ],
            [frame('f1', 'a0'), frame('f2', 'a1')],
        );
        expect(searchScene(doc, /x/gi).map((m) => m.id)).toEqual(['c', 'a', 'b']);
    });

    test('frames order by their own index, not by array position', () => {
        const doc = framed(
            [
                richtext({ id: 'a', index: 'a0', frameId: 'f2', html: '<p>x</p>' }),
                richtext({ id: 'b', index: 'a0', frameId: 'f1', html: '<p>x</p>' }),
            ],
            [frame('f2', 'a1'), frame('f1', 'a0')],
        );
        expect(searchScene(doc, /x/gi).map((m) => m.id)).toEqual(['b', 'a']);
    });

    test('an unframed element sorts before every frame', () => {
        const doc = framed(
            [
                richtext({ id: 'framed', index: 'a0', frameId: 'f1', html: '<p>x</p>' }),
                richtext({ id: 'loose', index: 'a1', html: '<p>x</p>' }),
            ],
            [frame('f1', 'a0')],
        );
        expect(searchScene(doc, /x/gi).map((m) => m.id)).toEqual(['loose', 'framed']);
    });

    test('context comes from the host', () => {
        const doc = framed([richtext({ id: 'a', frameId: 'f1', html: '<p>x</p>' })], [frame('f1', 'a0')]);
        const matches = searchScene(doc, /x/gi, { contextOf: (el) => `Slide ${el.frameId === 'f1' ? 1 : 2}` });
        expect(matches[0].context).toBe('Slide 1');
    });

    test('a label is one line, capped for the bar list', () => {
        const doc = scene([richtext({ id: 'a', html: `<p>launch</p><p>${'plan '.repeat(30)}</p>` })]);
        const label = searchScene(doc, /launch/gi)[0].label;
        expect(label.startsWith('launch plan plan')).toBe(true);
        expect(label.length).toBe(80);
    });

    test('a global regex is not left with a stale lastIndex between elements', () => {
        const doc = scene([
            richtext({ id: 'a', index: 'a0', html: '<p>needle</p>' }),
            richtext({ id: 'b', index: 'a1', html: '<p>needle</p>' }),
        ]);
        expect(searchScene(doc, /needle/g).map((m) => m.id)).toEqual(['a', 'b']);
    });
});
