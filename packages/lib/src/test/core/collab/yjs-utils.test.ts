import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { getIdArray, getIdArrayRoot, getItemMapRoot, restoreYjsDoc } from '../../../core/collab/yjs-utils';

describe('restoreYjsDoc', () => {
    test('restores Y.Map content into a doc that already registered the type via getMap', () => {
        const live = new Y.Doc();
        live.getMap('state').set('marker', 'V2');

        const target = new Y.Doc();
        target.getMap('state').set('marker', 'V1');

        restoreYjsDoc(live, Y.encodeStateAsUpdate(target), { state: 'map' });

        expect(live.getMap('state').get('marker')).toBe('V1');
    });

    test('restores Y.Array content into a doc that already registered the type via getArray', () => {
        const live = new Y.Doc();
        live.getArray('ops').push([1, 2, 3]);

        const target = new Y.Doc();
        target.getArray('ops').push(['a', 'b']);

        restoreYjsDoc(live, Y.encodeStateAsUpdate(target), { ops: 'array' });

        expect(live.getArray('ops').toArray()).toEqual(['a', 'b']);
    });

    test('restores when types are AbstractType — live doc hydrated via Y.applyUpdate only', () => {
        // Regression: server-side CollabDocument's Y.Doc is populated by
        // loadYjsState (which is Y.applyUpdate under the hood). That leaves
        // top-level types as AbstractType, NOT Y.Map / Y.Array. The original
        // `instanceof` check failed for both branches → restoreYjsDoc was a
        // no-op for server-side restore.
        const seed = new Y.Doc();
        seed.getMap('state').set('marker', 'V2');
        seed.getArray('ops').push([1, 2, 3]);
        const live = new Y.Doc();
        Y.applyUpdate(live, Y.encodeStateAsUpdate(seed));
        for (const value of live.share.values()) {
            expect(value.constructor.name).toBe('AbstractType');
        }

        const target = new Y.Doc();
        target.getMap('state').set('marker', 'V1');
        target.getArray('ops').push(['a', 'b']);

        restoreYjsDoc(live, Y.encodeStateAsUpdate(target), { state: 'map', ops: 'array' });

        expect(live.getMap('state').get('marker')).toBe('V1');
        expect(live.getArray('ops').toArray()).toEqual(['a', 'b']);
    });

    test('emits exactly one update event covering the whole transaction', () => {
        const seed = new Y.Doc();
        seed.getMap('state').set('marker', 'V2');
        const live = new Y.Doc();
        Y.applyUpdate(live, Y.encodeStateAsUpdate(seed));

        const target = new Y.Doc();
        target.getMap('state').set('marker', 'V1');

        let updates = 0;
        live.on('update', () => {
            updates += 1;
        });
        restoreYjsDoc(live, Y.encodeStateAsUpdate(target), { state: 'map' });
        expect(updates).toBe(1);
    });

    test('restores Y.XmlFragment with nested XmlElement and XmlText (Tiptap shape)', () => {
        // Live doc has a single paragraph with text "Live".
        const live = new Y.Doc();
        const liveFrag = live.getXmlFragment('default');
        const liveP = new Y.XmlElement('paragraph');
        const liveT = new Y.XmlText();
        liveT.insert(0, 'Live');
        liveP.insert(0, [liveT]);
        liveFrag.insert(0, [liveP]);

        // Target doc has a heading + paragraph with formatted text.
        const target = new Y.Doc();
        const targetFrag = target.getXmlFragment('default');
        const heading = new Y.XmlElement('heading');
        heading.setAttribute('level', '1');
        const headingText = new Y.XmlText();
        headingText.insert(0, 'Title');
        heading.insert(0, [headingText]);
        const para = new Y.XmlElement('paragraph');
        const paraText = new Y.XmlText();
        paraText.insert(0, 'Body', { bold: true });
        para.insert(0, [paraText]);
        targetFrag.insert(0, [heading, para]);

        restoreYjsDoc(live, Y.encodeStateAsUpdate(target), { default: 'xmlfragment' });

        const restoredFrag = live.getXmlFragment('default');
        expect(restoredFrag.toString()).toBe(
            '<heading level="1">Title</heading><paragraph><bold>Body</bold></paragraph>',
        );
    });

    test('restores XmlFragment when target side is AbstractType (server snapshot)', () => {
        // Mirror of the AbstractType regression for Map/Array, applied to XmlFragment.
        const seed = new Y.Doc();
        const seedFrag = seed.getXmlFragment('default');
        const seedP = new Y.XmlElement('paragraph');
        const seedT = new Y.XmlText();
        seedT.insert(0, 'Hello');
        seedP.insert(0, [seedT]);
        seedFrag.insert(0, [seedP]);

        // tempDoc-like: only Y.applyUpdate, never typed access — root stays AbstractType.
        const snapshotBytes = Y.encodeStateAsUpdate(seed);
        const live = new Y.Doc();
        Y.applyUpdate(live, snapshotBytes);
        expect(live.share.get('default')?.constructor.name).toBe('AbstractType');

        // Now mutate live, then restore back to the seed.
        live.getXmlFragment('default').delete(0, live.getXmlFragment('default').length);
        const newP = new Y.XmlElement('paragraph');
        const newT = new Y.XmlText();
        newT.insert(0, 'World');
        newP.insert(0, [newT]);
        live.getXmlFragment('default').insert(0, [newP]);

        restoreYjsDoc(live, snapshotBytes, { default: 'xmlfragment' });

        expect(live.getXmlFragment('default').toString()).toBe('<paragraph>Hello</paragraph>');
    });

    test('clears live root when target is empty', () => {
        const live = new Y.Doc();
        live.getMap('state').set('keep-me-not', 1);

        const target = new Y.Doc();
        target.getMap('state'); // declared but empty

        restoreYjsDoc(live, Y.encodeStateAsUpdate(target), { state: 'map' });

        expect([...live.getMap('state').keys()]).toEqual([]);
    });

    test('restores nested Y.Map inside Y.Map (sheets-style state)', () => {
        const live = new Y.Doc();
        const liveState = live.getMap('state');
        const liveInner = new Y.Map();
        liveInner.set('a', 1);
        liveState.set('inner', liveInner);

        const target = new Y.Doc();
        const targetState = target.getMap('state');
        const targetInner = new Y.Map();
        targetInner.set('b', 2);
        targetInner.set('c', 3);
        targetState.set('inner', targetInner);

        restoreYjsDoc(live, Y.encodeStateAsUpdate(target), { state: 'map' });

        const restoredInner = live.getMap('state').get('inner') as Y.Map<unknown>;
        expect(restoredInner.toJSON()).toEqual({ b: 2, c: 3 });
    });
});

describe('getItemMapRoot / getIdArrayRoot / getIdArray', () => {
    test('returns typed roots on a fresh doc', () => {
        const doc = new Y.Doc();
        const slides = getItemMapRoot(doc, 'slides');
        expect(slides).toBeInstanceOf(Y.Map);
        expect(slides.size).toBe(0);

        const slide = new Y.Map();
        slide.set('id', 'slide-1');
        slides.set('slide-1', slide);
        expect(getItemMapRoot(doc, 'slides').get('slide-1')?.get('id')).toBe('slide-1');
    });

    test('upgrades an AbstractType root left by Y.applyUpdate (server-side path)', () => {
        const seed = new Y.Doc();
        const seedSlide = new Y.Map();
        seedSlide.set('id', 'slide-1');
        seed.getMap('slides').set('slide-1', seedSlide);
        seed.getArray<string>('slideOrder').push(['slide-1']);

        const live = new Y.Doc();
        Y.applyUpdate(live, Y.encodeStateAsUpdate(seed));
        for (const value of live.share.values()) expect(value.constructor.name).toBe('AbstractType');

        expect(getItemMapRoot(live, 'slides').get('slide-1')?.get('id')).toBe('slide-1');
        expect(getIdArrayRoot(live, 'slideOrder').toArray()).toEqual(['slide-1']);
        expect(live.share.get('slides')).toBeInstanceOf(Y.Map);
        expect(live.share.get('slideOrder')).toBeInstanceOf(Y.Array);
    });

    test('reads a nested id array, and returns undefined for missing or non-array values', () => {
        const doc = new Y.Doc();
        const slides = getItemMapRoot(doc, 'slides');
        const slide = new Y.Map();
        const objectIds = new Y.Array<string>();
        objectIds.push(['obj-1', 'obj-2']);
        slide.set('objectIds', objectIds);
        slide.set('title', 'not an array');
        slides.set('slide-1', slide);

        expect(getIdArray(slide, 'objectIds')?.toArray()).toEqual(['obj-1', 'obj-2']);
        expect(getIdArray(slide, 'taskIds')).toBeUndefined();
        expect(getIdArray(slide, 'title')).toBeUndefined();
    });

    test('root id array reads as string[] without a cast', () => {
        const doc = new Y.Doc();
        getIdArrayRoot(doc, 'slideOrder').push(['a', 'b']);
        const order: string[] = getIdArrayRoot(doc, 'slideOrder').toArray();
        expect(order).toEqual(['a', 'b']);
    });

    test('throws on a genuine root type mismatch (fail loud on corruption)', () => {
        const doc = new Y.Doc();
        getItemMapRoot(doc, 'slides');
        expect(() => getIdArrayRoot(doc, 'slides')).toThrow();
    });
});
