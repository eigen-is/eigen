import { describe, expect, test } from 'bun:test';
import type { EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import { DEFAULT_ELEMENT_PROPS, ELEMENT_KINDS, VECTOR_STYLE_DEFAULTS, type VectorElement } from '@workspace/lib/vector';
import { Window } from 'happy-dom';
import { planElementsPaste } from '../../../../components/vector/tools/paste-elements';

// A pasted rich-text partial goes through the LightEditor sanitizer, which needs a DOM.
const window = new Window();
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.DOMParser = window.DOMParser;
g.document = window.document;
g.Node = window.Node;

const BASE = { ...DEFAULT_ELEMENT_PROPS, x: 10, y: 20, width: 100, height: 60, angle: 0 };

const rect = (id: string): VectorElement => ({
    ...BASE,
    ...ELEMENT_KINDS.rectangle.defaults(VECTOR_STYLE_DEFAULTS),
    id,
    type: 'rectangle',
    index: 'a0',
    seed: 1,
    commentCardIds: 'card-1',
});

const image = (id: string, mediaName: string): VectorElement => ({
    ...BASE,
    ...ELEMENT_KINDS.image.defaults(VECTOR_STYLE_DEFAULTS),
    id,
    type: 'image',
    index: 'a1',
    mediaName,
});

const richtext = (id: string, html: string): VectorElement => ({
    ...BASE,
    ...ELEMENT_KINDS.richtext.defaults(VECTOR_STYLE_DEFAULTS),
    id,
    type: 'richtext',
    index: 'a3',
    html,
});

const arrow = (id: string, startBinding: string): VectorElement => ({
    ...BASE,
    ...ELEMENT_KINDS.arrow.defaults(VECTOR_STYLE_DEFAULTS),
    id,
    type: 'arrow',
    index: 'a2',
    seed: 2,
    points: '[[0,0],[100,60]]',
    startBinding,
});

const imageItem = (mediaName: string, sourceParentId: string): EigenClipboardImageItem => ({
    type: 'image',
    mediaName,
    sourcePathId: 'p1',
    sourceParentId,
    sourceOwnerId: 'o1',
    sourceMountId: 'mt1',
    width: 100,
    height: 60,
});

describe('planElementsPaste', () => {
    test('a forged rich-text payload is sanitized before it can reach the document', () => {
        // Any web page can write our clipboard MIME, so the html on the wire is hostile until proven
        // otherwise. It is cleaned HERE, so nothing dangerous is ever stored in the Y.Doc.
        const el = richtext('t1', '<p>keep <em>this</em></p><script>alert(1)</script><img src=x onerror=alert(1)>');
        const partial = planElementsPaste([el], [], 'media-1').partials[0];
        expect(partial.html).toBe('<p>keep <em>this</em></p>');
    });

    test('images are dropped when the container has no media folder to resolve them against', () => {
        const plan = planElementsPaste([rect('r1'), image('i1', 'pic.png')], [imageItem('pic.png', 'other')], null);
        expect(plan.partials.map((p) => p.type)).toEqual(['rectangle']);
        expect(plan.crossMount).toEqual([]);
    });

    test('a partial is the whole stored record minus what the writer allocates', () => {
        const el = rect('r1');
        const { partials } = planElementsPaste([el], [], 'media-1');
        // id and index are the writer's; a copy starts with no comments.
        const { id, index, commentCardIds, ...rest } = el;
        expect(partials[0]).toEqual({ ...rest, commentCardIds: '' });
    });

    test('every element records its source id, so the arrow remap can follow the copies', () => {
        const plan = planElementsPaste([rect('r1'), arrow('a1', '{"elementId":"r1"}')], [], 'media-1');
        expect([...plan.cloneIds]).toEqual([
            [0, 'r1'],
            [1, 'a1'],
        ]);
        expect(plan.arrowRemaps).toEqual([{ index: 1, startBinding: '{"elementId":"r1"}', endBinding: '' }]);
    });

    test('an image from another container gets a pending name and a re-upload entry', () => {
        const plan = planElementsPaste([image('i1', 'photo.png')], [imageItem('photo.png', 'other-media')], 'media-1');
        expect(plan.partials[0]?.mediaName).toStartWith('pending:');
        expect(plan.crossMount).toEqual([{ index: 0, item: imageItem('photo.png', 'other-media') }]);
    });

    test('an image already in our media/ keeps its name and needs no re-upload', () => {
        const plan = planElementsPaste([image('i1', 'photo.png')], [imageItem('photo.png', 'media-1')], 'media-1');
        expect(plan.partials[0]?.mediaName).toBe('photo.png');
        expect(plan.crossMount).toEqual([]);
    });

    test('an image with no item beside it is dropped, and the later indices still line up', () => {
        // No item ⇒ it was copied mid-upload, so its bytes are fetchable from nowhere.
        const plan = planElementsPaste([image('i1', 'pending.png'), arrow('a1', '')], [], 'media-1');
        expect(plan.partials).toHaveLength(1);
        expect(plan.partials[0]?.type).toBe('arrow');
        expect(plan.arrowRemaps[0]?.index).toBe(0);
        expect([...plan.cloneIds]).toEqual([[0, 'a1']]);
    });
});
